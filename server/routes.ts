import type { Express } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { storage } from "./storage";
import { promises as fs } from "fs";
import path from "path";   // ✅ KEEP THIS
import { pool } from "./db";
import { pmsPool, saveSiteReportToPMS, getTasks, type PMSTask } from "./pmsSupabase";
import { getLMSHours } from "./lmsSupabase";
import { format, parseISO, eachDayOfInterval, isSameDay } from "date-fns";

// ✅ REPLACE WITH THIS (WORKS IN PM2 + CJS)
const __dirname = path.resolve();

import {
  insertOrganisationSchema,
  insertEmployeeSchema,
  insertTimeEntrySchema,
  insertDepartmentSchema,
  insertGroupSchema,
  insertSiteReportSchema,
  insertSiteReportAttachmentSchema,
  dailyPlans,
  planTasks,
} from "@shared/schema";

import { createClient } from "@supabase/supabase-js";
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

// Store connected WebSocket clients for real-time updates
const clients: Set<WebSocket> = new Set();

function broadcast(type: string, data: any) {
  const message = JSON.stringify({ type, data });
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// Helper function to check if a project deadline has passed
function isProjectExpired(endDate: string | null): boolean {
  if (!endDate) return false;

  try {
    const projectEndDate = new Date(endDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    projectEndDate.setHours(0, 0, 0, 0);
    return projectEndDate < today;
  } catch (error) {
    console.error("Error parsing project end date:", endDate, error);
    return false;
  }
}

function isAfterPlanCutoff(): boolean {
  const now = new Date();
  // Normalize to UTC first, then add IST offset (5.5h)
  const utcNow = now.getTime() + (now.getTimezoneOffset() * 60000);
  const istNow = new Date(utcNow + (5.5 * 60 * 60 * 1000));
  
  // Use UTC methods to get the "local" components of the shifted date
  const hours = istNow.getUTCHours();
  const minutes = istNow.getUTCMinutes();
  
  // Return true if current time in IST is past 12:30 PM
  return (hours > 12) || (hours === 12 && minutes >= 30);
}

// Batch enrich entries to avoid N+1 query problem
async function batchEnrichEntries(entries: any[]) {
  if (entries.length === 0) return [];

  const subtaskIds = entries.filter(e => e.pmsSubtaskId).map(e => e.pmsSubtaskId);
  const directTaskIds = entries.filter(e => e.pmsId && !e.pmsSubtaskId).map(e => e.pmsId);

  const subtaskMap = new Map<string, string>(); // subtaskId -> taskId
  const taskDetailsMap = new Map<string, { keyStepId: string | null, startDate: string | null, endDate: string | null }>();
  const keyStepMap = new Map<string, string>(); // keyStepId -> title

  try {
    // 1. Fetch subtasks to get their parent task IDs
    if (subtaskIds.length > 0) {
      const subRes = await pmsPool.query('SELECT id, task_id FROM subtasks WHERE id = ANY($1::uuid[])', [subtaskIds]);
      subRes.rows.forEach(row => subtaskMap.set(row.id, row.task_id));
    }

    // 2. Collect all unique task IDs (direct + from subtasks)
    const allTaskIds = Array.from(new Set([...directTaskIds, ...Array.from(subtaskMap.values())]));

    // 3. Fetch task details
    if (allTaskIds.length > 0) {
      const taskRes = await pmsPool.query('SELECT id, key_step_id, start_date, end_date FROM project_tasks WHERE id = ANY($1::uuid[])', [allTaskIds]);
      taskRes.rows.forEach(row => taskDetailsMap.set(row.id, {
        keyStepId: row.key_step_id,
        startDate: row.start_date,
        endDate: row.end_date
      }));
    }

    // 4. Collect all unique key step IDs
    const allKeyStepIds = Array.from(new Set(
      Array.from(taskDetailsMap.values())
        .map(t => t.keyStepId)
        .filter(id => id !== null)
    )) as string[];

    // 5. Fetch key step titles
    if (allKeyStepIds.length > 0) {
      const keyRes = await pmsPool.query('SELECT id, title FROM key_steps WHERE id = ANY($1::uuid[])', [allKeyStepIds]);
      keyRes.rows.forEach(row => keyStepMap.set(row.id, row.title));
    }
  } catch (err) {
    console.error('[PMS-BATCH-ENRICH] failed to resolve batch data', err);
  }

  // 6. Map back to entries
  return entries.map(e => {
    let taskId = e.pmsId;
    if (e.pmsSubtaskId) {
      taskId = subtaskMap.get(e.pmsSubtaskId) || null;
    }

    const details = taskId ? taskDetailsMap.get(taskId) : null;
    const keyStepName = details?.keyStepId ? keyStepMap.get(details.keyStepId) : null;

    return {
      ...e,
      keyStep: e.keyStep || keyStepName,
      pmsStartDate: details?.startDate || null,
      pmsEndDate: details?.endDate || null
    };
  });
}

// Keep single enrichment for individual item routes
async function enrichEntry(e: any) {
  const enriched = await batchEnrichEntries([e]);
  return enriched[0];
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // Initialize WebSocket server for real-time updates
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
  });

  // Seed managers and default employees on startup
  await storage.seedManagers();
  await storage.seedDefaultEmployees();

  // ============ AUTH ROUTES ============
  app.post("/api/auth/login", async (req, res) => {
    try {
      const { employeeCode, password } = req.body;

      if (!employeeCode || !password) {
        return res.status(400).json({ error: "Employee code and password are required" });
      }

      const employee = await storage.validateEmployee(employeeCode, password);

      if (!employee) {
        return res.status(401).json({ error: "Invalid employee code or password" });
      }

      // Don't send password to client
      const { password: _, ...safeEmployee } = employee;
      res.json({ user: safeEmployee });
    } catch (error) {
      console.error("Login error:", error);
      res.status(500).json({ error: "Login failed" });
    }
  });

  // ============ EMAIL TEST ROUTE ============
  app.get("/api/test/email-config", async (req, res) => {
    res.json({
      RESEND_API_KEY: process.env.RESEND_API_KEY ? "✓ Present" : "✗ Missing",
      FROM_EMAIL: process.env.FROM_EMAIL || "Not set",
      SENDER_EMAIL: process.env.SENDER_EMAIL || "Not set",
    });
  });

  // ============ ORGANISATION ROUTES ============
  app.get("/api/organisations", async (req, res) => {
    try {
      const orgs = await storage.getOrganisations();
      res.json(orgs);
    } catch (error) {
      console.error("Get organisations error:", error);
      res.status(500).json({ error: "Failed to fetch organisations" });
    }
  });

  app.post("/api/organisations", async (req, res) => {
    try {
      const result = insertOrganisationSchema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({ error: result.error.errors });
      }

      const org = await storage.createOrganisation(result.data);
      broadcast("organisation_created", org);
      res.status(201).json(org);
    } catch (error) {
      console.error("Create organisation error:", error);
      res.status(500).json({ error: "Failed to create organisation" });
    }
  });

  app.patch("/api/organisations/:id", async (req, res) => {
    try {
      const org = await storage.updateOrganisation(req.params.id, req.body);
      if (!org) {
        return res.status(404).json({ error: "Organisation not found" });
      }
      broadcast("organisation_updated", org);
      res.json(org);
    } catch (error) {
      console.error("Update organisation error:", error);
      res.status(500).json({ error: "Failed to update organisation" });
    }
  });

  app.delete("/api/organisations/:id", async (req, res) => {
    try {
      await storage.deleteOrganisation(req.params.id);
      broadcast("organisation_deleted", { id: req.params.id });
      res.json({ success: true });
    } catch (error) {
      console.error("Delete organisation error:", error);
      res.status(500).json({ error: "Failed to delete organisation" });
    }
  });

  // ============ DEPARTMENT ROUTES ============
  app.get("/api/departments", async (req, res) => {
    try {
      const depts = await storage.getDepartments();
      res.json(depts);
    } catch (error) {
      console.error("Get departments error:", error);
      res.status(500).json({ error: "Failed to fetch departments" });
    }
  });

  app.post("/api/departments", async (req, res) => {
    try {
      const result = insertDepartmentSchema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({ error: result.error.errors });
      }

      const dept = await storage.createDepartment(result.data);
      broadcast("department_created", dept);
      res.status(201).json(dept);
    } catch (error) {
      console.error("Create department error:", error);
      res.status(500).json({ error: "Failed to create department" });
    }
  });

  app.patch("/api/departments/:id", async (req, res) => {
    try {
      const dept = await storage.updateDepartment(req.params.id, req.body);
      if (!dept) {
        return res.status(404).json({ error: "Department not found" });
      }
      broadcast("department_updated", dept);
      res.json(dept);
    } catch (error) {
      console.error("Update department error:", error);
      res.status(500).json({ error: "Failed to update department" });
    }
  });

  app.delete("/api/departments/:id", async (req, res) => {
    try {
      await storage.deleteDepartment(req.params.id);
      broadcast("department_deleted", { id: req.params.id });
      res.json({ success: true });
    } catch (error) {
      console.error("Delete department error:", error);
      res.status(500).json({ error: "Failed to delete department" });
    }
  });

  // ============ GROUP ROUTES ============
  app.get("/api/groups", async (req, res) => {
    try {
      const grps = await storage.getGroups();
      res.json(grps);
    } catch (error) {
      console.error("Get groups error:", error);
      res.status(500).json({ error: "Failed to fetch groups" });
    }
  });

  app.post("/api/groups", async (req, res) => {
    try {
      const result = insertGroupSchema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({ error: result.error.errors });
      }

      const group = await storage.createGroup(result.data);
      broadcast("group_created", group);
      res.status(201).json(group);
    } catch (error) {
      console.error("Create group error:", error);
      res.status(500).json({ error: "Failed to create group" });
    }
  });

  app.patch("/api/groups/:id", async (req, res) => {
    try {
      const group = await storage.updateGroup(req.params.id, req.body);
      if (!group) {
        return res.status(404).json({ error: "Group not found" });
      }
      broadcast("group_updated", group);
      res.json(group);
    } catch (error) {
      console.error("Update group error:", error);
      res.status(500).json({ error: "Failed to update group" });
    }
  });

  app.delete("/api/groups/:id", async (req, res) => {
    try {
      await storage.deleteGroup(req.params.id);
      broadcast("group_deleted", { id: req.params.id });
      res.json({ success: true });
    } catch (error) {
      console.error("Delete group error:", error);
      res.status(500).json({ error: "Failed to delete group" });
    }
  });

  // ============ EMPLOYEE ROUTES ============
  app.get("/api/employees", async (req, res) => {
    try {
      const emps = await storage.getEmployees();
      // Remove passwords from response
      const safeEmps = emps.map(({ password, ...emp }) => emp);
      res.json(safeEmps);
    } catch (error) {
      console.error("Get employees error:", error);
      res.status(500).json({ error: "Failed to fetch employees" });
    }
  });

  app.post("/api/employees", async (req, res) => {
    try {
      const result = insertEmployeeSchema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({ error: result.error.errors });
      }

      // Check if employee code already exists
      const existing = await storage.getEmployeeByCode(result.data.employeeCode);
      if (existing) {
        return res.status(400).json({ error: "Employee code already exists" });
      }

      const emp = await storage.createEmployee(result.data);
      const { password, ...safeEmp } = emp;
      broadcast("employee_created", safeEmp);
      res.status(201).json(safeEmp);
    } catch (error) {
      console.error("Create employee error:", error);
      res.status(500).json({ error: "Failed to create employee" });
    }
  });

  // ============ MANAGER ROUTES ============
  app.get("/api/managers", async (req, res) => {
    try {
      const mgrs = await storage.getManagers();
      res.json(mgrs);
    } catch (error) {
      console.error("Get managers error:", error);
      res.status(500).json({ error: "Failed to fetch managers" });
    }
  });

  // ============ PROJECTS ROUTES ============
  app.get("/api/projects", async (req, res) => {
    try {
      const { userRole, userEmpCode, userDepartment } = req.query;
      const projects = await storage.getProjects(userRole as string, userEmpCode as string, userDepartment as string);
      res.json(projects);
    } catch (error) {
      console.error("Get projects error:", error);
      res.status(500).json({ error: "Failed to fetch projects" });
    }
  });

  app.post("/api/projects", async (req, res) => {
    try {
      const project = await storage.createProject(req.body);
      broadcast("project_created", project);
      res.status(201).json(project);
    } catch (error) {
      console.error("Create project error:", error);
      res.status(500).json({ error: "Failed to create project" });
    }
  });

  // ============ TASKS ROUTES ============
  app.get("/api/tasks", async (req, res) => {
    try {
      const { projectId, userDepartment, userEmpCode, userRole } = req.query;
      const tasks = await storage.getTasks(
        projectId as string, 
        userDepartment as string, 
        userEmpCode as string, 
        userRole as string
      );
      res.json(tasks);
    } catch (error) {
      console.error("Get tasks error:", error);
      res.status(500).json({ error: "Failed to fetch tasks" });
    }
  });

  app.post("/api/tasks", async (req, res) => {
    try {
      const task = await storage.createTask(req.body);
      broadcast("task_created", task);
      res.status(201).json(task);
    } catch (error) {
      console.error("Create task error:", error);
      res.status(500).json({ error: "Failed to create task" });
    }
  });

  // ============ SUBTASKS ROUTES ============
  app.get("/api/subtasks", async (req, res) => {
    try {
      const { taskId, userDepartment } = req.query;

      // Get PMS subtasks
      const pmsSubtasks = await storage.getPMSSubtasks(taskId as string, userDepartment as string);

      // For now, only return PMS subtasks since local subtasks table may not exist
      res.json(pmsSubtasks);
    } catch (error) {
      console.error("Get subtasks error:", error);
      res.status(500).json({ error: "Failed to fetch subtasks" });
    }
  });

  app.post("/api/subtasks", async (req, res) => {
    try {
      const subtask = await storage.createSubtask(req.body);
      broadcast("subtask_created", subtask);
      res.status(201).json(subtask);
    } catch (error) {
      console.error("Create subtask error:", error);
      res.status(500).json({ error: "Failed to create subtask" });
    }
  });

  // ============ KEY STEPS ROUTE (PMS) ============
  app.get('/api/key-steps', async (req, res) => {
    const { projectId } = req.query;
    try {
      if (!projectId) return res.json([]);

      // Query PMS DB for key steps tied to the project code
      const query = `
        SELECT ks.id, ks.title AS name
        FROM key_steps ks
        INNER JOIN projects p ON ks.project_id = p.id
        WHERE p.project_code = $1
        ORDER BY ks.title
      `;
      const result = await pmsPool.query(query, [projectId]);
      const rows = result && result.rows ? result.rows : [];
      res.json(rows);
    } catch (error) {
      console.error('❌ Get key steps error for projectId:', projectId, error);
      res.status(500).json([]);
    }
  });

  // ============ LMS ROUTES ============
  app.get("/api/lms/hours", async (req, res) => {
    try {
      const { employeeCode, date } = req.query;
      if (!employeeCode || !date) {
        return res.status(400).json({ error: "employeeCode and date are required" });
      }
      const hours = await getLMSHours(employeeCode as string, date as string);
      res.json(hours);
    } catch (error) {
      console.error("Get LMS hours error:", error);
      res.status(500).json({ error: "Failed to fetch LMS hours" });
    }
  });

  // ============ TIME ENTRY ROUTES ============
  app.get("/api/time-entries", async (req, res) => {
    try {
      const entries = await storage.getTimeEntries();

      // Batch enrich entries with key step name from PMS (if linked via pmsId or pmsSubtaskId)
      const enriched = await batchEnrichEntries(entries);
      res.json(enriched);
    } catch (error) {
      console.error("Get time entries error:", error);
      res.status(500).json({ error: "Failed to fetch time entries" });
    }
  });

  app.get("/api/time-entries/pending", async (req, res) => {
    try {
      const entries = await storage.getPendingTimeEntries();
      res.json(entries);
    } catch (error) {
      console.error("Get pending entries error:", error);
      res.status(500).json({ error: "Failed to fetch pending entries" });
    }
  });

  app.get("/api/time-entries/employee/:employeeId", async (req, res) => {
    try {
      const entries = await storage.getTimeEntriesByEmployee(req.params.employeeId);
      const enriched = await batchEnrichEntries(entries);
      res.json(enriched);
    } catch (error) {
      console.error("Get employee entries error:", error);
      res.status(500).json({ error: "Failed to fetch employee entries" });
    }
  });

  app.get("/api/time-entries/:id", async (req, res) => {
    try {
      const entry = await storage.getTimeEntry(req.params.id);
      if (!entry) {
        return res.status(404).json({ error: "Time entry not found" });
      }
      res.json(await enrichEntry(entry));
    } catch (error) {
      console.error("Get time entry error:", error);
      res.status(500).json({ error: "Failed to fetch time entry" });
    }
  });

  app.post("/api/time-entries", async (req, res) => {
    try {
      // Manual field extraction to ensure all data is captured
      const entryData = {
        ...req.body,
        employeeId: req.body.employeeId,
        employeeCode: req.body.employeeCode,
        employeeName: req.body.employeeName,
        date: req.body.date,
        projectName: req.body.projectName,
        taskDescription: req.body.taskDescription,
        problemAndIssues: req.body.problemAndIssues || null,
        quantify: req.body.quantify || "",
        achievements: req.body.achievements || null,
        scopeOfImprovements: req.body.scopeOfImprovements || null,
        toolsUsed: req.body.toolsUsed || [],
        startTime: req.body.startTime,
        endTime: req.body.endTime,
        totalHours: req.body.totalHours,
        percentageComplete: parseInt(req.body.percentageComplete) || 0,
        pmsId: req.body.pmsId || null,
        pmsSubtaskId: req.body.pmsSubtaskId || null,
        keyStep: req.body.keyStep || null,
      };

      const result = insertTimeEntrySchema.safeParse(entryData);
      if (!result.success) {
        console.error("[TIME-ENTRY] Validation error:", result.error);
        return res.status(400).json({ error: result.error });
      }

      // Plan for the Day Check (Only for today or future dates)
      const todayStr = new Date().toLocaleDateString('en-CA'); // 'YYYY-MM-DD' in local time equivalent using CA locale format or just ISO up to T
      // To ensure correct comparison, let's just use string comparison with today's date in YYYY-MM-DD
      const now = new Date();
      const offset = now.getTimezoneOffset() * 60000;
      const localTodayStr = new Date(now.getTime() - offset).toISOString().split('T')[0];

      const isPastDay = entryData.date < localTodayStr;

      if (!isPastDay) {
        const plan = await storage.getDailyPlanByDate(entryData.employeeId, entryData.date);
        if (!plan) {
           return res.status(403).json({ error: "You must submit your 'Plan for the Day' before filling timesheets." });
        }

        // Check if task exists in the plan
        const planTasks = await storage.getPlanTasks(plan.id);
        let isPlanned = planTasks.some(pt => pt.taskId === entryData.pmsId || pt.taskId === entryData.pmsSubtaskId);
        
        // If not directly planned, check if it's a subtask of a planned task
        if (!isPlanned && entryData.pmsSubtaskId) {
           const { getSubtaskById } = await import('./pmsSupabase');
           const subtask = await getSubtaskById(entryData.pmsSubtaskId);
           if (subtask && subtask.task_id) {
             isPlanned = planTasks.some(pt => pt.taskId === subtask.task_id);
           }
        }

        if (!isPlanned && (entryData.pmsId || entryData.pmsSubtaskId)) {
           // Instead of blocking, we automatically add it as a deviation
           console.log(`[TIME-ENTRY] Task ${entryData.pmsId || entryData.pmsSubtaskId} not in plan. Adding as auto-deviation.`);
           try {
             await storage.createPlanTask({
               planId: plan.id,
               taskId: entryData.pmsId || entryData.pmsSubtaskId || 'unplanned',
               projectName: entryData.projectName,
               taskName: entryData.taskDescription,
               isDeviation: true,
               deviationReason: "Automatically added via timesheet submission",
               status: 'approved'
             });
           } catch (devErr) {
             console.error("[TIME-ENTRY] Failed to auto-create deviation:", devErr);
           }
        }
      }

      const entry = await storage.createTimeEntry(result.data);

      // Handle PMS Status Synchronization & Bottom-Up Aggregation
      try {
        console.log(`[PMS-SYNC] Starting sync. pmsId: ${req.body.pmsId}, pmsSubtaskId: ${req.body.pmsSubtaskId}, progress: ${entryData.percentageComplete}%`);
        const { updateSubtaskProgress, updateTaskProgress, getProjectProgress, getProjects } = await import('./pmsSupabase');

        let targetProjectId: string | null = null;

        // CASE 1: Subtask exists - update subtask progress (triggers bottom-up update)
        if (req.body.pmsSubtaskId) {
          console.log(`[PMS-SYNC] Updating subtask ${req.body.pmsSubtaskId} progress`);
          await updateSubtaskProgress(req.body.pmsSubtaskId, entryData.percentageComplete);
          
          // Resolve project ID for broadcast
          const res = await pmsPool.query('SELECT project_id FROM project_tasks pt JOIN subtasks s ON pt.id = s.task_id WHERE s.id = $1::uuid', [req.body.pmsSubtaskId]);
          if (res.rows && res.rows.length > 0) targetProjectId = res.rows[0].project_id;
        }
        // CASE 2: No subtask - update task progress directly (triggers bottom-up update)
        else if (req.body.pmsId) {
          console.log(`[PMS-SYNC] Updating task ${req.body.pmsId} progress (no subtask) using date ${entry.date}`);
          await updateTaskProgress(req.body.pmsId, entryData.percentageComplete, entry.date);
          
          // Resolve project ID for broadcast
          const res = await pmsPool.query('SELECT project_id FROM project_tasks WHERE id = $1::uuid', [req.body.pmsId]);
          if (res.rows && res.rows.length > 0) targetProjectId = res.rows[0].project_id;
        }

        // If we found the project, synchronize points and broadcast
        if (targetProjectId) {
          const finalProgress = await getProjectProgress(targetProjectId);
          console.log(`[PMS-SYNC] Final Project ${targetProjectId} progress: ${finalProgress}%`);
          
          // Sync with gamification points (Max 600 points = 100%)
          // This ensures the AchievementTree grows based on project completion %
          const targetPoints = Math.round(finalProgress * 6);
          try {
            await pool.query(
              `INSERT INTO project_points (project_id, points, last_active) 
               VALUES ($1, $2, NOW()) 
               ON CONFLICT (project_id) DO UPDATE SET points = EXCLUDED.points, last_active = NOW()`,
              [entry.projectName, targetPoints]
            );
          } catch (pErr) { console.error('Failed to sync project points:', pErr); }

          broadcast("project_progress_updated", { 
            projectId: entry.projectName, 
            progress: finalProgress,
            points: targetPoints
          });
        }
      } catch (pmsSyncError) {
        console.error("[PMS-SYNC] Error during progress synchronization:", pmsSyncError);
      }
      // ==================================

      broadcast("time_entry_created", entry);

      // NOTE: Email notifications are now sent per day (not per task) via /api/time-entries/submit-daily
      // This prevents multiple emails for multiple tasks submitted on the same day
      console.log('[EMAIL] Task created - email will be sent with daily digest endpoint');

      res.status(201).json(entry);
    } catch (error) {
      console.error("Create time entry error:", error);
      res.status(500).json({ error: "Failed to create time entry" });
    }
  });

  // Update a time entry (only if pending)
  app.put("/api/time-entries/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const entry = await storage.getTimeEntry(id);

      if (!entry) {
        return res.status(404).json({ error: "Time entry not found" });
      }

      if (entry.status !== 'pending' && entry.status !== 'rejected') {
        return res.status(400).json({ error: "Cannot edit entry that is not pending or rejected" });
      }

      // If it was rejected, reset status to pending upon update
      const updateData = entry.status === 'rejected'
        ? { ...req.body, status: 'pending', rejectionReason: null }
        : req.body;

      const updatedEntry = await storage.updateTimeEntry(id, updateData);
      broadcast("time_entry_updated", updatedEntry);
      res.json(updatedEntry);
    } catch (error) {
      console.error("Update time entry error:", error);
      res.status(500).json({ error: "Failed to update time entry" });
    }
  });

  // Delete a time entry (only if pending)
  app.delete("/api/time-entries/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const entry = await storage.getTimeEntry(id);

      if (!entry) {
        return res.status(404).json({ error: "Time entry not found" });
      }

      if (entry.status !== 'pending') {
        return res.status(400).json({ error: "Cannot delete entry that is not pending" });
      }

      await storage.deleteTimeEntry(id);
      broadcast("time_entry_deleted", { id });
      res.json({ success: true });
    } catch (error) {
      console.error("Delete time entry error:", error);
      res.status(500).json({ error: "Failed to delete time entry" });
    }
  });

  // Submit daily tasks summary email
  app.post("/api/time-entries/submit-daily/:employeeId/:date", async (req, res) => {
    try {
      const { employeeId, date } = req.params;

      // fetch every entry for the user on the requested date
      const entries = await storage.getTimeEntriesByEmployeeAndDate(employeeId, date);
      if (entries.length === 0) {
        return res.status(404).json({ error: "No tasks found for this date" });
      }

      // Enrich entries with PMS data (dates, key steps etc)
      const dailyEntries = await Promise.all(entries.map(e => enrichEntry(e)));

      const employee = await storage.getEmployee(employeeId);
      if (!employee) {
        return res.status(404).json({ error: "Employee not found" });
      }

      const parseDurationToMinutes = (duration: string): number => {
        if (!duration) return 0;
        const match = duration.match(/(\d+)h\s*(\d+)m?/);
        if (match) {
          return parseInt(match[1], 10) * 60 + parseInt(match[2] || '0', 10);
        }
        const hours = parseFloat(duration);
        return isNaN(hours) ? 0 : Math.round(hours * 60);
      };

      const formatDuration = (minutes: number): string => {
        const hours = Math.floor(minutes / 60);
        const mins = minutes % 60;
        return `${hours}h ${mins}m`;
      };

      const totalMinutes = dailyEntries.reduce((sum, entry) => {
        return sum + parseDurationToMinutes(entry.totalHours);
      }, 0);

      // Fetch LMS hours to validate 8-hour rule
      const lmsData = await getLMSHours(employee.employeeCode, date);
      const totalLMSMinutes = Math.round(lmsData.totalLMSHours * 60);
      const combinedMinutes = totalMinutes + totalLMSMinutes;

      // 1. Check if already submitted
      const existingSubmission = await storage.getDailySubmissionByDate(employeeId, date);
      if (existingSubmission) {
        return res.status(400).json({ 
          error: "Already Submitted", 
          message: `You have already made a final submission for ${date}.` 
        });
      }

      // 2. Working Hours Validation (Enforce 8 hours)
      const REQUIRED_MINUTES = 8 * 60; // 8 hours
      if (combinedMinutes < REQUIRED_MINUTES) {
        return res.status(400).json({ 
          error: "Insufficient hours", 
          message: `Total working hours (Timesheet + Leave/Permission) must be at least 8 hours. Current total: ${formatDuration(combinedMinutes)}`,
          workMinutes: totalMinutes,
          lmsMinutes: totalLMSMinutes,
          totalMinutes: combinedMinutes
        });
      }

      const totalHoursFormatted = formatDuration(totalMinutes);

      // Save the daily submission record
      await storage.createDailySubmission({
        employeeId,
        date,
        totalHours: totalHoursFormatted
      });

      // use the raw entries as tasks so the email helper has full data
      const tasks = dailyEntries;
      const { sendTimesheetSummaryEmail, sendTimesheetConfirmationEmail } = await import('./email');
      
      // 1. Send summary to Admin/HR (Existing)
      const emailResult = await sendTimesheetSummaryEmail({
        employeeId: employee.id,
        employeeName: employee.name,
        employeeCode: employee.employeeCode,
        date,
        totalHours: totalHoursFormatted,
        tasks,
        status: 'pending',
      });

      // 2. Send confirmation to employee (New)
      if (employee.email) {
        try {
          await sendTimesheetConfirmationEmail({
            employeeName: employee.name,
            employeeCode: employee.employeeCode,
            employeeEmail: employee.email,
            date,
            totalHours: totalHoursFormatted,
            tasks: tasks.map(t => ({
              projectName: t.projectName || '—',
              taskDescription: t.taskDescription || '—',
              totalHours: t.totalHours || '—',
              status: t.status || 'pending'
            }))
          });
          console.log(`[CONFIRMATION EMAIL] Sent to ${employee.email}`);
        } catch (confirmErr) {
          console.error('[CONFIRMATION EMAIL] Failed:', confirmErr);
        }
      }

      if (!emailResult.success) {
        return res.status(500).json({
          error: "Failed to send daily summary email",
          details: emailResult.error,
        });
      }

      console.log(`[DAILY SUBMIT] Daily summary and confirmation sent for ${employee.name} on ${date}`);
      res.json({
        success: true,
        message: `Daily summary email sent for ${date} with ${dailyEntries.length} tasks`,
        taskCount: dailyEntries.length,
        totalHours: totalHoursFormatted,
        emailId: emailResult.result?.id,
      });
    } catch (error) {
      console.error("Submit daily summary error:", error);
      res.status(500).json({ error: "Failed to submit daily summary" });
    }
  });

  app.get("/api/daily-submission", async (req, res) => {
    try {
      const { employeeId, date } = req.query;
      if (!employeeId || !date) {
        return res.status(400).json({ error: "Missing employeeId or date" });
      }
      const submission = await storage.getDailySubmissionByDate(employeeId as string, date as string);
      res.json(submission || null);
    } catch (error) {
      console.error("Error fetching daily submission:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  // Manager approval (first stage of dual approval)
  app.patch("/api/time-entries/:id/manager-approve", async (req, res) => {
    try {
      const { approvedBy } = req.body;
      const entry = await storage.managerApproveTimeEntry(req.params.id, approvedBy);

      if (!entry) {
        return res.status(404).json({ error: "Time entry not found" });
      }

      // if every task for that day has been manager_approved, send one summary to employee
      const allTasks = await storage.getTimeEntriesByEmployeeAndDate(entry.employeeId, entry.date);
      const allHRApproved = allTasks.every(t => t.status === 'manager_approved');
      if (allHRApproved) {
        const employee = await storage.getEmployee(entry.employeeId);
        const approver = await storage.getEmployee(approvedBy);
        try {
          const { sendApprovalSummaryEmail } = await import('./email');
          await sendApprovalSummaryEmail({
            employeeId: entry.employeeId,
            employeeName: entry.employeeName,
            employeeCode: entry.employeeCode,
            date: entry.date,
            tasks: allTasks,
            status: 'manager_approved',
            recipients: employee?.email ? [employee.email] : undefined,
            approverName: approver?.name,
          });
        } catch (emailError) {
          console.error('[EMAIL] Failed to send grouped HR approval email:', emailError);
        }
      }

      broadcast("time_entry_updated", entry);
      res.json(entry);
    } catch (error) {
      console.error("Manager approve entry error:", error);
      res.status(500).json({ error: "Failed to approve entry" });
    }
  });

  // Admin approval (final stage of dual approval)
  app.patch("/api/time-entries/:id/approve", async (req, res) => {
    try {
      const { approvedBy } = req.body;
      const entry = await storage.adminApproveTimeEntry(req.params.id, approvedBy);

      if (!entry) {
        return res.status(404).json({ error: "Time entry not found" });
      }

      // check if full day is now finally approved
      const allTasks = await storage.getTimeEntriesByEmployeeAndDate(entry.employeeId, entry.date);
      const allApproved = allTasks.every(t => t.status === 'approved');
      if (allApproved) {
        const employee = await storage.getEmployee(entry.employeeId);
        const approver = await storage.getEmployee(approvedBy);
        try {
          const { sendApprovalSummaryEmail } = await import('./email');
          // build recipient list: default + employee
          const defaultRecipients = (process.env.SENDER_EMAIL || "").split(",").map(e => e.trim()).filter(Boolean);
          const recipients = employee?.email ? [...defaultRecipients, employee.email] : defaultRecipients;
          await sendApprovalSummaryEmail({
            employeeId: entry.employeeId,
            employeeName: entry.employeeName,
            employeeCode: entry.employeeCode,
            date: entry.date,
            tasks: allTasks,
            status: 'approved',
            recipients,
            approverName: approver?.name,
          });
        } catch (emailError) {
          console.error('[EMAIL] Failed to send grouped final approval email:', emailError);
        }
      }

      broadcast("time_entry_updated", entry);
      res.json(entry);
    } catch (error) {
      console.error("Approve entry error:", error);
      res.status(500).json({ error: "Failed to approve entry" });
    }
  });

  // ============ SITE REPORT ROUTES ============
  app.get("/api/site-reports", async (req, res) => {
    try {
      const { employeeId } = req.query;
      const reports = await storage.getSiteReports(employeeId as string);
      res.json(reports);
    } catch (error) {
      console.error("Get site reports error:", error);
      res.status(500).json({ error: "Failed to fetch site reports" });
    }
  });

  app.get("/api/site-reports/:id", async (req, res) => {
    try {
      const report = await storage.getSiteReport(req.params.id);
      if (!report) return res.status(404).json({ error: "Report not found" });
      const attachments = await storage.getSiteReportAttachments(req.params.id);
      res.json({ ...report, attachments });
    } catch (error) {
      console.error("Get site report error:", error);
      res.status(500).json({ error: "Failed to fetch site report" });
    }
  });

  app.post("/api/site-reports", async (req, res) => {
    try {
      const result = insertSiteReportSchema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({ error: result.error.errors });
      }

      const report = await storage.createSiteReport(result.data);

      try {
        await saveSiteReportToPMS(report);
      } catch (pmsErr) {
        console.error("Failed to save site report to PMS:", pmsErr);
      }

      broadcast("site_report_created", report);
      res.status(201).json(report);
    } catch (error) {
      console.error("Create site report error:", error);
      res.status(500).json({ error: "Failed to create site report" });
    }
  });

  // Upload attachment for site report (stores base64 data)
  app.post("/api/site-reports/upload", async (req, res) => {
    try {
      const { reportId, fileName, fileType, base64Data } = req.body;
      if (!reportId || !fileName || !fileType || !base64Data) {
        return res.status(400).json({ error: "Missing required fields: reportId, fileName, fileType, base64Data" });
      }

      // Store as data URI so it can be embedded in emails
      const fileUrl = `data:${fileType};base64,${base64Data}`;

      const attachment = await storage.createSiteReportAttachment({
        reportId,
        fileName,
        fileType,
        fileUrl,
        fileSize: Math.round(base64Data.length * 0.75), // approximate decoded size
      });

      res.status(201).json(attachment);
    } catch (error) {
      console.error("Upload attachment error:", error);
      res.status(500).json({ error: "Failed to upload attachment" });
    }
  });

  app.post("/api/site-reports/:id/send-email", async (req, res) => {
    try {
      const reportId = req.params.id;
      const report = await storage.getSiteReport(reportId);
      if (!report) return res.status(404).json({ error: "Report not found" });

      const attachments = await storage.getSiteReportAttachments(reportId);
      const { sendSiteReportEmail } = await import('./email');

      const emailResult = await sendSiteReportEmail({
        employeeName: report.employeeName,
        projectName: report.projectName,
        date: report.date,
        workCategory: report.workCategory,
        startTime: report.startTime,
        endTime: report.endTime,
        duration: report.duration,
        workDone: report.workDone,
        issuesFaced: report.issuesFaced || undefined,
        materialsUsed: report.materialsUsed || undefined,
        laborCount: report.laborCount || 0,
        laborDetails: (report as any).laborDetails || undefined,
        sqftCovered: (report as any).sqftCovered || undefined,
        laborData: (report as any).laborData || undefined,
        location: report.locationLat && report.locationLng ? { lat: report.locationLat, lng: report.locationLng } : undefined,
        attachments: attachments.map(a => ({ fileName: a.fileName, fileUrl: a.fileUrl, fileType: a.fileType })),
        recipients: (report as any).emailRecipients ? (report as any).emailRecipients.split(',').map((s: string) => s.trim()).filter(Boolean) : [],
      });

      if (!emailResult.success) {
        return res.status(500).json({ error: "Failed to send email", details: emailResult.error });
      }

      res.json({ success: true, message: "Professional report emailed successfully" });
    } catch (error) {
      console.error("Send site report email error:", error);
      res.status(500).json({ error: "Failed to send site report email" });
    }
  });

  app.patch("/api/site-reports/:id/status", async (req, res) => {
    try {
      const { status } = req.body;
      if (!['pending', 'approved', 'rejected'].includes(status)) {
        return res.status(400).json({ error: "Invalid status" });
      }
      const report = await storage.updateSiteReport(req.params.id, { status });
      if (!report) return res.status(404).json({ error: "Report not found" });
      broadcast("site_report_updated", report);
      res.json(report);
    } catch (error) {
      console.error("Update site report status error:", error);
      res.status(500).json({ error: "Failed to update status" });
    }
  });

  app.post("/api/site-reports/upload", async (req, res) => {
    try {
      const { reportId, fileName, fileType, base64Data } = req.body;
      if (!reportId || !fileName || !fileType || !base64Data) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      // Convert base64 to buffer
      const buffer = Buffer.from(base64Data, 'base64');
      const filePath = `site-reports/${reportId}/${Date.now()}_${fileName}`;

      const { data, error } = await supabase.storage
        .from('site-reports')
        .upload(filePath, buffer, {
          contentType: fileType,
          upsert: true
        });

      if (error) throw error;

      const { data: { publicUrl } } = supabase.storage
        .from('site-reports')
        .getPublicUrl(filePath);

      const attachment = await storage.createSiteReportAttachment({
        reportId,
        fileName,
        fileType,
        fileUrl: publicUrl,
        fileSize: buffer.length,
      });

      res.status(201).json(attachment);
    } catch (error) {
      console.error("Upload site report attachment error:", error);
      res.status(500).json({ error: "Failed to upload attachment" });
    }
  });

  app.patch("/api/time-entries/:id/reject", async (req, res) => {
    try {
      const { approvedBy, reason } = req.body;
      const entry = await storage.updateTimeEntryStatus(req.params.id, "rejected", approvedBy, reason);

      if (!entry) {
        return res.status(404).json({ error: "Time entry not found" });
      }

      // after updating, collect all rejected tasks for the same date
      const allTasks = await storage.getTimeEntriesByEmployeeAndDate(entry.employeeId, entry.date);
      const rejectedTasks = allTasks.filter(t => t.status === 'rejected');

      const employee = await storage.getEmployee(entry.employeeId);
      const approver = await storage.getEmployee(approvedBy);

      try {
        const { sendApprovalSummaryEmail } = await import('./email');
        await sendApprovalSummaryEmail({
          employeeId: entry.employeeId,
          employeeName: entry.employeeName,
          employeeCode: entry.employeeCode,
          date: entry.date,
          tasks: rejectedTasks,
          status: 'rejected',
          recipients: employee?.email ? [employee.email] : undefined,
          approverName: approver?.name,
          rejectionReason: reason,
        });
      } catch (emailError) {
        console.error('[EMAIL] Failed to send grouped rejection email:', emailError);
      }

      broadcast("time_entry_updated", entry);
      res.json(entry);
    } catch (error) {
      console.error("Reject entry error:", error);
      res.status(500).json({ error: "Failed to reject entry" });
    }
  });

  app.patch("/api/time-entries/:id/reopen", async (req, res) => {
    try {
      const entry = await storage.reopenTimeEntry(req.params.id);
      if (!entry) {
        return res.status(404).json({ error: "Time entry not found" });
      }
      broadcast("time_entry_updated", entry);
      res.json(entry);
    } catch (error) {
      console.error("Reopen entry error:", error);
      res.status(500).json({ error: "Failed to reopen entry" });
    }
  });

  app.patch("/api/time-entries/:id/resubmit", async (req, res) => {
    try {
      const entry = await storage.resubmitTimeEntry(req.params.id, req.body);
      if (!entry) {
        return res.status(404).json({ error: "Time entry not found" });
      }
      broadcast("time_entry_updated", entry);
      res.json(entry);
    } catch (error) {
      console.error("Resubmit entry error:", error);
      res.status(500).json({ error: "Failed to resubmit entry" });
    }
  });

  app.patch("/api/time-entries/:id/on-hold", async (req, res) => {
    try {
      const { reason, managerId } = req.body;
      if (!reason || !managerId) {
        return res.status(400).json({ error: "Reason and managerId are required" });
      }
      const entry = await storage.onHoldTimeEntry(req.params.id, reason, managerId);
      if (!entry) {
        return res.status(404).json({ error: "Time entry not found" });
      }
      broadcast("time_entry_updated", entry);
      res.json(entry);
    } catch (error) {
      console.error("On-hold entry error:", error);
      res.status(500).json({ error: "Failed to set entry on hold" });
    }
  });

  // ============ DISCUSSION ROUTES ============
  app.get("/api/discussions", async (req, res) => {
    try {
      const { entryId, employeeId } = req.query;
      let discussions;
      if (entryId) {
        discussions = await storage.getDiscussionsByEntry(entryId as string);
      } else if (employeeId) {
        discussions = await storage.getDiscussionsByEmployee(employeeId as string);
      } else {
        discussions = await storage.getAllDiscussions();
      }
      res.json(discussions);
    } catch (error) {
      console.error("Get discussions error:", error);
      res.status(500).json({ error: "Failed to fetch discussions" });
    }
  });

  app.post("/api/discussions", async (req, res) => {
    try {
      const discussion = await storage.createDiscussion(req.body);
      broadcast("new_discussion", discussion);
      res.json(discussion);
    } catch (error) {
      console.error("Create discussion error:", error);
      res.status(500).json({ error: "Failed to create discussion" });
    }
  });

  // ============ NOTIFICATION ROUTES ============
  app.post("/api/notifications/timesheet-submitted", async (req, res) => {
    try {
      const { employeeId, employeeName, employeeCode, date } = req.body;

      console.log(`[NOTIFICATION] grouping submission for ${employeeName} (${employeeCode}) on ${date}`);

      const allTasks = await storage.getTimeEntriesByEmployeeAndDate(employeeId, date);
      console.log(`[NOTIFICATION] fetched ${allTasks.length} tasks from database`);
      if (allTasks.length === 0) {
        console.warn(`[NOTIFICATION] no tasks found for ${employeeId} on ${date}`);
        return res.status(404).json({ error: "No tasks found for that date" });
      }

      const parseDurationToMinutes = (duration: string): number => {
        if (!duration) return 0;
        const match = duration.match(/(\d+)h\s*(\d+)m?/);
        if (match) {
          return parseInt(match[1], 10) * 60 + parseInt(match[2] || '0', 10);
        }
        const hours = parseFloat(duration);
        return isNaN(hours) ? 0 : Math.round(hours * 60);
      };

      const formatDuration = (minutes: number): string => {
        const hours = Math.floor(minutes / 60);
        const mins = minutes % 60;
        return `${hours}h ${mins}m`;
      };

      const totalMinutes = allTasks.reduce((acc, t) => acc + parseDurationToMinutes(t.totalHours || "0"), 0);
      const totalHours = formatDuration(totalMinutes);

      let lmsHoursText: string | undefined = undefined;
      let combinedTotalHours: string = totalHours;

      try {
        const employee = await storage.getEmployee(employeeId);
        if (employee) {
          const lmsData = await getLMSHours(employee.employeeCode, date);
          if (lmsData && lmsData.totalLMSHours > 0) {
            lmsHoursText = `${lmsData.totalLMSHours}h`;
            const combinedMinutes = totalMinutes + Math.round(lmsData.totalLMSHours * 60);
            combinedTotalHours = formatDuration(combinedMinutes);
          }
        }
      } catch (lmsErr) {
        console.error('[NOTIFICATION] Failed to fetch LMS hours for email:', lmsErr);
      }

      try {
        const { sendTimesheetSummaryEmail } = await import('./email');
        const emailResult = await sendTimesheetSummaryEmail({
          employeeId,
          employeeName,
          employeeCode,
          date,
          totalHours: combinedTotalHours,
          taskHours: totalHours,
          lmsHours: lmsHoursText,
          tasks: allTasks,
          status: 'pending',
        });
        console.log('[EMAIL] Grouped submission email sent, result:', emailResult);
      } catch (emailError) {
        console.error('[EMAIL] Failed to send grouped summary:', emailError);
      }

      // notify front end if needed
      broadcast("timesheet_submitted", { employeeName, employeeCode, date, totalHours });

      res.json({ success: true, taskCount: allTasks.length, totalHours });
    } catch (error) {
      console.error("Notification error:", error);
      res.status(500).json({ error: "Failed to send notification" });
    }
  });

  // ============ PMS INTEGRATION ROUTES ============
  // Settings storage for timesheet blocking policy
  const SETTINGS_PATH = path.join(__dirname, '..', 'server-settings.json');

  async function readSettings() {
    try {
      const raw = await fs.readFile(SETTINGS_PATH, 'utf-8');
      return JSON.parse(raw || '{}');
    } catch (e) {
      return { blockUnassignedProjectTasks: false };
    }
  }

  async function writeSettings(s: any) {
    try {
      await fs.writeFile(SETTINGS_PATH, JSON.stringify(s, null, 2), 'utf-8');
      return true;
    } catch (e) {
      console.error('Failed to write settings', e);
      return false;
    }
  }
  app.get("/api/projects", async (req, res) => {
    try {
      const { userRole, userEmpCode, userDepartment } = req.query;
      const { getProjects } = await import('./pmsSupabase');
      const pmsProjects = await getProjects(userRole as string, userEmpCode as string, userDepartment as string);

      // Add isExpired flag to each project
      const projectsWithExpiry = pmsProjects.map(p => ({
        ...p,
        isExpired: isProjectExpired(p.end_date || null),
      }));

      res.json(projectsWithExpiry);
    } catch (error) {
      console.error("PMS projects error:", error);
      res.status(500).json({ error: "Failed to fetch PMS projects" });
    }
  });

  app.get("/api/tasks", async (req, res) => {
    try {
      const { projectId, userDepartment, userEmpCode } = req.query;
      const { getTasks } = await import('./pmsSupabase');
      const tasks = await getTasks(projectId as string, userDepartment as string, userEmpCode as string);
      res.json(tasks);
    } catch (error) {
      console.error("PMS tasks error:", error);
      res.status(500).json({ error: "Failed to fetch PMS tasks" });
    }
  });

// Helper to determine if a PMS task should be auto-synced based on its schedule
function shouldSyncPMSTask(task: PMSTask, targetDateStr: string): boolean {
  if (!task.schedule_type || task.schedule_type === 'None') return false;

  const targetDate = new Date(targetDateStr);
  const dayName = format(targetDate, 'EEEE'); // e.g. "Monday"
  const dayOfMonth = targetDate.getDate();

  switch (task.schedule_type) {
    case 'Daily':
      return true;
    case 'Weekly':
      const weeklyDays = Array.isArray(task.schedule_data?.weekdays) ? task.schedule_data.weekdays : [];
      return weeklyDays.includes(dayName);
    case 'Monthly':
      const monthlyDates = Array.isArray(task.schedule_data?.dates) ? task.schedule_data.dates : [];
      return monthlyDates.includes(dayOfMonth);
    case 'Custom':
      if (!task.start_date || !task.end_date) return false;
      const start = new Date(task.start_date);
      const end = new Date(task.end_date);
      // Normalize to compare just dates
      const t = new Date(targetDateStr).getTime();
      return t >= start.getTime() && t <= end.getTime();
    default:
      return false;
  }
}

  // Return pending tasks assigned to employee that are due on given date and not completed
  app.get('/api/pending-deadline-tasks', async (req, res) => {
    try {
      const employeeId = req.query.employeeId as string;
      const dateStr = req.query.date as string; // yyyy-mm-dd
      if (!employeeId || !dateStr) return res.status(400).json({ error: 'employeeId and date are required' });

      const employee = await storage.getEmployee(employeeId);
      if (!employee) return res.status(404).json({ error: 'Employee not found' });

      const userDept = employee.department || '';
      const { getProjects, getTasks, updateTaskInPMS } = await import('./pmsSupabase');
      const projects = await getProjects(employee.role, employee.employeeCode, userDept);

      const pending: any[] = [];
      const target = new Date(dateStr);

      // Normalize date to local yyyy-mm-dd key to avoid timezone shifts
      const formatDateLocal = (d: Date) => {
        const dt = new Date(d);
        return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
      };

      const targetKey = formatDateLocal(target);

      const settings = await readSettings();
      const includeProjectTasks = !!settings.blockUnassignedProjectTasks;

      for (const project of projects) {
        const tasks = await getTasks(project.project_code, userDept, employee.employeeCode);
        for (const t of tasks) {
          // determine assignee match
          const assignedTo = (t.assignee || (t as any).assigned_to || '').toString();
          const members = Array.isArray((t as any).task_members) ? (t as any).task_members : [];
          const isAssigned = assignedTo === employee.employeeCode || members.includes(employee.employeeCode) || false;

          const taskDeadline = t.end_date ? new Date(t.end_date) : null;
          const taskKey = taskDeadline ? formatDateLocal(taskDeadline) : null;

          const notCompleted = !((t as any).is_completed || (t.status && t.status.toLowerCase() === 'completed'));

          // Diagnostic logging: why a task is included/excluded
          try {
            const debugInfo: any = {
              taskId: t.id,
              taskName: (t as any).task_name || (t as any).name || null,
              assignedTo: assignedTo || null,
              members: members || null,
              taskKey,
              targetKey,
              notCompleted,
              isAssignedMatch: isAssigned || false,
            };
            console.log('[PENDING-CHECK] task debug:', JSON.stringify(debugInfo));
          } catch (e) {
            // ignore logging errors
          }

          // Include task as pending if its deadline matches target and it's not completed.
          // Previously we filtered by assignment/settings; to ensure users cannot submit when any
          // task is due today, ignore those criteria here.
          const shouldInclude = taskKey && taskKey === targetKey && notCompleted;
          if (shouldInclude) {
            pending.push({
              ...t,
              projectCode: project.project_code,
              projectName: project.project_name,
              projectDeadline: project.end_date || null,
              // expose whether the task was explicitly assigned to employee
              isAssignedToEmployee: isAssigned || false,
            });
            console.log('[PENDING-CHECK] Included task:', t.id, (t as any).task_name || '');
          } else {
            // log exclusion reason lightly
            if (taskKey && taskKey === targetKey && !notCompleted) {
              console.log('[PENDING-CHECK] Excluded (already completed):', t.id);
            } else if (!taskKey) {
              console.log('[PENDING-CHECK] Excluded (no deadline):', t.id);
            } else if (taskKey !== targetKey) {
              console.log('[PENDING-CHECK] Excluded (date mismatch):', t.id, 'taskKey=', taskKey, 'targetKey=', targetKey);
            } else {
              console.log('[PENDING-CHECK] Excluded (other):', t.id);
            }
          }
        }
      }

      res.json(pending);
    } catch (error) {
      console.error('Pending deadline tasks error:', error);
      res.status(500).json({ error: 'Failed to compute pending tasks', details: String(error) });
    }
  });

  // Postpone a task: record postponement in local DB and update PMS
  app.post('/api/tasks/:id/postpone', async (req, res) => {
    try {
      const taskId = req.params.id;
      const { previousDueDate, newDueDate, reason, postponedBy, taskName } = req.body;
      if (!newDueDate || !reason) return res.status(400).json({ error: 'newDueDate and reason are required' });

      // Use raw DB via storage
      // ensure table exists (best-effort)
      try {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS task_postponements (
            id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
            task_id varchar NOT NULL,
            task_name text,
            previous_due_date text,
            new_due_date text NOT NULL,
            reason text NOT NULL,
            postponed_by varchar,
            postponed_at timestamp default now(),
            postpone_count integer default 1
          )`);
      } catch (e) {
        // ignore
      }

      // determine previous postpone count for this task
      const countRes = await pool.query(`SELECT COUNT(*)::int as cnt FROM task_postponements WHERE task_id = $1`, [taskId]);
      const previousCount = countRes.rows && countRes.rows[0] ? parseInt(countRes.rows[0].cnt, 10) : 0;
      const newCount = previousCount + 1;

      // insert postponement record with incremented count
      const insertRes = await pool.query(
        `INSERT INTO task_postponements (task_id, task_name, previous_due_date, new_due_date, reason, postponed_by, postpone_count) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [taskId, taskName || null, previousDueDate || null, newDueDate, reason, postponedBy || null, newCount]
      );
      const dbRes = insertRes.rows && insertRes.rows[0] ? insertRes.rows[0] : null;

      // update PMS task
      const { updateTaskInPMS } = await import('./pmsSupabase');
      const updated = await updateTaskInPMS(taskId, { end_date: newDueDate });

      // Notify HR and Admin
      try {
        // Get project details to find organization, but generic HR/Admin notification is acceptable as per request
        // We'll Notify all admins and HRs
        // In a real app we might filter by project's organization, but for now we broadcast to role
        const employees = await storage.getEmployees();
        const notifyList = employees.filter(e => e.role === 'admin' || e.role === 'hr' || e.department === 'HR & Admin');
        const recipientEmails = notifyList.map(e => e.email).filter(Boolean) as string[];

        // Also notify the employee who postponed (confirmation)
        let actorName = postponedBy || 'Unknown User';
        if (postponedBy) {
          const actor = await storage.getEmployee(postponedBy);
          if (actor) {
            if (actor.email) recipientEmails.push(actor.email);
            actorName = `${actor.name} (${actor.employeeCode})`;
          }
        }

        const uniqueRecipients = Array.from(new Set(recipientEmails));

        if (uniqueRecipients.length > 0) {
          try {
            const { sendTaskPostponementEmail } = await import('./email');

            const fmtPrev = previousDueDate && !isNaN(new Date(previousDueDate).getTime())
              ? new Date(previousDueDate).toLocaleDateString('en-IN')
              : (previousDueDate ? previousDueDate.split('T')[0] : 'N/A');

            const fmtNew = newDueDate && !isNaN(new Date(newDueDate).getTime())
              ? new Date(newDueDate).toLocaleDateString('en-IN')
              : newDueDate;

            await sendTaskPostponementEmail({
              recipients: uniqueRecipients,
              taskName: taskName || taskId,
              postponedByDetails: actorName,
              reason: reason,
              newDueDate: fmtNew,
              previousDueDate: fmtPrev
            });
          } catch (e) {
            console.error("Failed to send extension email:", e);
          }
          console.log(`[EMAIL] Postponement notification sent to ${uniqueRecipients.length} recipients`);
        }
      } catch (notifyErr) {
        console.error('[EMAIL] Failed to send postponement notification:', notifyErr);
      }

      res.json({ success: true, postponement: dbRes, updatedPMS: updated });
    } catch (error) {
      console.error('Postpone task error:', error);
      res.status(500).json({ error: 'Failed to postpone task', details: String(error) });
    }
  });

  // Acknowledge task deadline without extending
  app.post('/api/tasks/:id/acknowledge', async (req, res) => {
    try {
      const taskId = req.params.id;
      const { acknowledgedBy, projectCode } = req.body;

      if (!acknowledgedBy) return res.status(400).json({ error: 'acknowledgedBy is required' });

      // ensure table exists
      try {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS task_deadline_acknowledgements (
            id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
            task_id varchar NOT NULL,
            acknowledged_by varchar NOT NULL,
            acknowledged_at timestamp default now(),
            project_code text
          )`);
      } catch (e) {
        // ignore
      }

      const result = await pool.query(
        `INSERT INTO task_deadline_acknowledgements (task_id, acknowledged_by, project_code) VALUES ($1, $2, $3) RETURNING *`,
        [taskId, acknowledgedBy, projectCode || null]
      );

      res.json({ success: true, acknowledgement: result.rows[0] });
    } catch (error) {
      console.error('Acknowledge task error:', error);
      res.status(500).json({ error: 'Failed to acknowledge task', details: String(error) });
    }
  });

  // Get all postponement history for Admin
  app.get('/api/admin/postponements', async (req, res) => {
    try {
      console.log(`[ADMIN-POSTPONEMENTS] Received request for history`);
      const postponements = await storage.getAllTaskPostponements();
      console.log(`[ADMIN-POSTPONEMENTS] Found ${postponements.length} records`);

      if (postponements.length > 0) {
        console.log(`[ADMIN-POSTPONEMENTS] Sample:`, JSON.stringify(postponements[0]).substring(0, 100));
      } else {
        // Run a manual check if empty
        const manualCheck = await pool.query('SELECT COUNT(*) FROM task_postponements');
        console.log(`[ADMIN-POSTPONEMENTS] Manual count check: ${manualCheck.rows[0].count}`);
      }

      res.json(postponements);
    } catch (error) {
      console.error('Get admin postponements error:', error);
      res.status(500).json({ error: 'Failed to fetch postponements' });
    }
  });

  app.get('/api/tasks/:id/postponements', async (req, res) => {
    try {
      const taskId = req.params.id;
      // ensure table exists (best-effort)
      try {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS task_postponements (
            id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
            task_id varchar NOT NULL,
            previous_due_date text,
            new_due_date text NOT NULL,
            reason text NOT NULL,
            postponed_by varchar,
            postponed_at timestamp default now(),
            postpone_count integer default 1
          )`);
      } catch (e) {
        // ignore
      }

      const q = await pool.query(`SELECT id, task_id as "taskId", previous_due_date as "previousDueDate", new_due_date as "newDueDate", reason, postponed_by as "postponedBy", postponed_at as "postponedAt", postpone_count as "postponeCount" FROM task_postponements WHERE task_id = $1 ORDER BY postponed_at DESC`, [taskId]);
      res.json(Array.isArray(q.rows) ? q.rows : []);
    } catch (error) {
      console.error('Get postponements error:', error);
      res.status(500).json({ error: 'Failed to fetch postponements', details: String(error) });
    }
  });

  app.get("/api/subtasks", async (req, res) => {
    try {
      const { taskId, userDepartment, userEmpCode } = req.query;
      const { getSubtasks } = await import('./pmsSupabase');
      const subtasks = await getSubtasks(taskId as string, userDepartment as string, userEmpCode as string);
      res.json(subtasks);
    } catch (error) {
      console.error("PMS subtasks error:", error);
      res.status(500).json({ error: "Failed to fetch PMS subtasks" });
    }
  });

  // ============ DAILY PLAN ROUTES ============
  app.get("/api/daily-plans/today/:employeeId", async (req, res) => {
    try {
      const { employeeId } = req.params;
      const date = new Date().toISOString().split('T')[0];
      const plan = await storage.getDailyPlanByDate(employeeId, date);
      
      if (!plan) {
        return res.json({ submitted: false });
      }

      const tasks = await storage.getPlanTasks(plan.id);
      res.json({ submitted: true, plan, tasks });
    } catch (error) {
      console.error("Get today's plan error:", error);
      res.status(500).json({ error: "Failed to fetch today's plan" });
    }
  });

  app.get("/api/daily-plans/:date/:employeeId", async (req, res) => {
    try {
      const { date, employeeId } = req.params;
      const plan = await storage.getDailyPlanByDate(employeeId, date);
      
      if (!plan) {
        return res.json({ submitted: false });
      }

      const tasks = await storage.getPlanTasks(plan.id);
      // Fetch postponements for this employee on this specific date
      const postponements = await pool.query(
        `SELECT task_name, reason, new_due_date FROM task_postponements WHERE postponed_by = $1 AND DATE(postponed_at) = $2::date`,
        [employeeId, date]
      );
      
      res.json({ 
        submitted: true, 
        plan, 
        tasks, 
        postponedTasks: postponements.rows || [] 
      });
    } catch (error) {
      console.error("Get plan by date error:", error);
      res.status(500).json({ error: "Failed to fetch plan for this date" });
    }
  });

  // ---- Plan Window Control (E0046 only) ----
  app.get("/api/plan-window", async (_req, res) => {
    const settings = await readSettings();
    const now = new Date();
    const utcNow = now.getTime() + (now.getTimezoneOffset() * 60000);
    const istNow = new Date(utcNow + (5.5 * 60 * 60 * 1000));
    const today = format(istNow, "yyyy-MM-dd");
    
    const isAutomatedClosed = await storage.isDailyPlanClosed(today);
    const isPastCutoff = isAfterPlanCutoff();
    
    // Portal is open ONLY if manual setting is open AND it hasn't been automated closed AND it's not past 12:30 PM
    const planWindowOpen = !!settings.planWindowOpen && !isAutomatedClosed && !isPastCutoff;

    res.json({ 
      planWindowOpen,
      isAutomatedClosed,
      isPastCutoff,
      cutoffTime: "12:30 PM",
      serverTime: new Date().toISOString()
    });
  });

  app.patch("/api/plan-window", async (req, res) => {
    try {
      const { employeeId, open } = req.body;
      const employee = await storage.getEmployee(employeeId);
      if (employee?.employeeCode !== 'E0046') {
        return res.status(403).json({ error: "Only E0046 can control the plan window." });
      }
      const settings = await readSettings();
      const wasOpen = !!settings.planWindowOpen;
      settings.planWindowOpen = !!open;
      await writeSettings(settings);

      // Trigger email if portal is closed
      if (wasOpen && !open) {
        try {
          const { sendPlanWindowClosedEmail } = await import('./email');
          const allEmployees = await storage.getEmployees();
          const recipients = allEmployees.filter(e => e.isActive && e.email).map(e => e.email) as string[];
          const today = new Date().toLocaleDateString('en-IN');
          
          if (recipients.length > 0) {
            await sendPlanWindowClosedEmail({
              recipients,
              closedBy: employee.name,
              date: today
            });
            console.log(`[PLAN CLOSED EMAIL] Sent to ${recipients.length} employees`);
          }
        } catch (emailErr) {
          console.error('[PLAN CLOSED EMAIL] Failed:', emailErr);
        }
      }

      broadcast("plan_window_changed", { planWindowOpen: !!open, changedBy: employee.name });
      res.json({ planWindowOpen: !!open });
    } catch (err) {
      res.status(500).json({ error: "Failed to update plan window." });
    }
  });
  // ---- End Plan Window Control ----

  app.post("/api/daily-plans", async (req, res) => {
    try {
      const { employeeId, date, selectedTasks, unselectedTasks } = req.body;
      const now = new Date();
      const planDate = date || now.toISOString().split('T')[0];

      // Check if plan window toggle is open (manual control has priority, but 12:30 cutoff is STRICT)
      const settings = await readSettings();
      const isPastCutoff = isAfterPlanCutoff();

      if (isPastCutoff) {
        return res.status(403).json({ 
          error: "Plan window is strictly closed for today (12:30 PM cutoff).",
          message: "Plan closed for today (12:30 PM cutoff)"
        });
      }

      if (!settings.planWindowOpen) {
        // Portal is manually CLOSED - block submissions
        return res.status(403).json({ error: "Plan window is currently closed. Submissions are not allowed. Contact your administrator to reopen." });
      }

      // Portal is manually OPEN and not past cutoff - allow submissions

      // Enforce auto-selected PMS tasks are included
      const { getProjects } = await import('./pmsSupabase');
      const employee = await storage.getEmployee(employeeId);
      if (employee) {
        const userDept = employee.department || '';
        const projects = await getProjects(employee.role, employee.employeeCode, userDept);
        const { getTasks } = await import('./pmsSupabase');
        const getISTTodayKey = (): string => {
          const now = new Date();
          // Adjust for IST (UTC+5.5) regardless of server locale
          const utcNow = now.getTime() + (now.getTimezoneOffset() * 60000);
          const istNow = new Date(utcNow + (5.5 * 60 * 60 * 1000));
          return istNow.toISOString().split('T')[0];
        };
        const todayKey = getISTTodayKey();

        for (const project of projects) {
          const projectTasks = await getTasks(project.project_code, userDept, employee.employeeCode, employee.role);
          const mandatoryTasks = projectTasks.filter(t => shouldSyncPMSTask(t, todayKey));
          for (const mt of mandatoryTasks) {
            const isIncluded = selectedTasks.some((st: any) => st.id === mt.id);
            if (!isIncluded) {
              return res.status(400).json({ 
                error: `Mandatory PMS task '${mt.task_name}' is missing from your plan.`,
                taskId: mt.id
              });
            }
          }
        }
      }

      // Plan window is always open unless explicitly restricted by other future logic
      const isInTimeWindow = true; 
      let plan;
      const existingPlan = await storage.getDailyPlanByDate(employeeId, planDate);
      
      if (existingPlan) {
        // If plan exists, we'll "re-submit" it by clearing tasks and starting over
        // This is only allowed if the window is forced open or during the 9-12 AM window
        plan = existingPlan;
        // Delete existing tasks for this plan
        await pool.query('DELETE FROM plan_tasks WHERE plan_id = $1', [plan.id]);
      } else {
        plan = await storage.createDailyPlan({ employeeId, date: planDate });
      }

      // Save selected tasks
      for (const t of selectedTasks) {
        await storage.createPlanTask({
          planId: plan.id,
          taskId: t.id,
          projectName: t.projectName || t.project_code,
          taskName: t.task_name,
          isDeviation: false,
          status: 'approved',
          source: t.source || 'Manual',
          isLocked: !!t.isLocked
        });
      }

      // Save unselected tasks as postponements
      for (const t of unselectedTasks) {
         await pool.query(
            `INSERT INTO task_postponements (task_id, task_name, reason, previous_due_date, new_due_date, postponed_by, postponed_at) 
             VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [t.taskId, t.taskName, t.reason, null, t.newDueDate, employeeId]
         );
      }

      broadcast("daily_plan_submitted", { plan, employeeId });

      // Email notification
      try {
        const { sendDailyPlanSubmittedEmail, sendDailyPlanConfirmationEmail } = await import('./email');
        const emp = await storage.getEmployee(employeeId);
        
        if (emp) {
          // 1. Send to Admin/HR (Existing)
          await sendDailyPlanSubmittedEmail({
            employeeName: emp.name,
            employeeCode: emp.employeeCode,
            selectedTasks: selectedTasks,
            unselectedTasks: unselectedTasks || []
          });

          // 2. Send confirmation to employee (New)
          if (emp.email) {
            await sendDailyPlanConfirmationEmail({
              employeeName: emp.name,
              employeeCode: emp.employeeCode,
              employeeEmail: emp.email,
              date: planDate,
              selectedTasks: selectedTasks,
              unselectedTasks: unselectedTasks || []
            });
          }
        }
      } catch (emailErr) {
        console.error('[EMAIL] Daily plan notification failed:', emailErr);
      }

      res.status(201).json(plan);
    } catch (error) {
      console.error("Create daily plan error:", error);
      res.status(500).json({ error: "Failed to create daily plan" });
    }
  });

  app.post("/api/daily-plans/reminder", async (req, res) => {
    try {
      const { employeeId } = req.body;
      
      // Validate request
      if (!employeeId) {
        return res.status(400).json({ error: "Missing employeeId in request body" });
      }

      const actor = await storage.getEmployee(employeeId);
      
      // Access Restricted: Only E0046 and E0048 can send reminders
      if (!actor || (actor.employeeCode !== 'E0046' && actor.employeeCode !== 'E0048')) {
        console.warn(`[REMINDER API] Unauthorized access attempt by: ${employeeId}`);
        return res.status(403).json({ error: "Unauthorized. Access limited to E0046 and E0048." });
      }

      console.log(`[REMINDER API] Starting reminder send by ${actor.employeeCode}...`);

      const allEmployees = await storage.getEmployees();
      if (!allEmployees || allEmployees.length === 0) {
        console.warn("[REMINDER API] No employees found in database");
        return res.status(200).json({ success: true, count: 0, failed: [], message: "No employees to send reminders to" });
      }

      const activeEmployees = allEmployees.filter(e => e.isActive && e.role !== 'admin' && e.email);
      console.log(`[REMINDER API] Found ${activeEmployees.length} active employees with email`);

      const today = format(new Date(), 'yyyy-MM-dd');
      
      let { sendDailyPlanReminderEmail } = await import('./email');
      if (!sendDailyPlanReminderEmail) {
        throw new Error("sendDailyPlanReminderEmail function not found");
      }

      let sentCount = 0;
      const failed: Array<{ employeeCode: string; email: string | null; error: any }> = [];

      for (const emp of activeEmployees) {
        try {
          // Verify email is valid string (should already be verified by filter, but double-check)
          if (!emp.email || typeof emp.email !== 'string') {
            console.warn(`[REMINDER API] Employee ${emp.employeeCode} has invalid email: ${emp.email}`);
            failed.push({ 
              employeeCode: emp.employeeCode, 
              email: emp.email || null,
              error: 'Invalid email address' 
            });
            continue;
          }

          // Fetch tasks for employee
          let pendingTasks: string[] = [];
          try {
            const tasks = await getTasks(undefined, undefined, emp.employeeCode);
            if (Array.isArray(tasks) && tasks.length > 0) {
              pendingTasks = tasks
                .filter((t: any) => t && t.task_name)
                .map((t: any) => String(t.task_name).trim())
                .filter((name: string) => name.length > 0);
            }
          } catch (taskErr) {
            console.warn(`[REMINDER API] Failed to fetch tasks for ${emp.employeeCode}:`, taskErr);
            // Continue without tasks - this is not a blocker
          }

          // Send reminder email to all active employees (regardless of submission status)
          const result = await sendDailyPlanReminderEmail({ 
            recipients: [emp.email], 
            pendingTasks 
          });

          if (result?.success) {
            sentCount += 1;
            console.log(`[REMINDER API] ✓ Sent to ${emp.employeeCode} (${emp.email})`);
          } else {
            failed.push({ 
              employeeCode: emp.employeeCode, 
              email: emp.email,
              error: result?.error || 'Unknown error' 
            });
            console.error(`[REMINDER API] ✗ Failed for ${emp.employeeCode}: ${result?.error || 'unknown'}`);
          }
        } catch (empErr) {
          console.error(`[REMINDER API] Error processing ${emp.employeeCode}:`, empErr);
          failed.push({ 
            employeeCode: emp.employeeCode, 
            email: emp.email,
            error: empErr instanceof Error ? empErr.message : String(empErr) 
          });
        }
      }

      console.log(`[REMINDER API] Summary: Sent=${sentCount}, Failed=${failed.length}`);

      if (sentCount === 0 && failed.length > 0) {
        return res.status(400).json({ 
          error: "Failed to send any reminder emails", 
          details: { failed, sentCount } 
        });
      }

      return res.json({ 
        success: true, 
        count: sentCount, 
        failed,
        summary: `Sent ${sentCount} reminder(s) to all active employees. ${failed.length} failed.`
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("[REMINDER API] Failed:", err);
      res.status(500).json({ 
        error: "Server error while sending reminders",
        details: process.env.NODE_ENV === 'development' ? errorMsg : undefined
      });
    }
  });

  // ============ END OF DAY TRACKING ROUTE ============
  app.post("/api/admin/check-missing-submissions", async (req, res) => {
    try {
      const { actorId } = req.body;
      const actor = await storage.getEmployee(actorId);
      if (!actor || (actor.role !== 'admin' && actor.role !== 'hr')) {
        return res.status(403).json({ error: "Unauthorized. Admin/HR only." });
      }

      const now = new Date();
      const hour = now.getHours();
      if (hour < 12) {
        return res.status(403).json({ error: "Close Alert can only be sent at or after 12:00 PM." });
      }

      const today = now.toISOString().split('T')[0];
      const allEmployees = await storage.getEmployees();
      const activeEmployees = allEmployees.filter(e => e.isActive && e.role === 'employee');

      const missedTimesheet: any[] = [];
      const missedDailyPlan: any[] = [];
      const missedByEmployee = new Map<string, any>();

      for (const emp of activeEmployees) {
        const plan = await storage.getDailyPlanByDate(emp.id, today);
        const entries = await storage.getTimeEntriesByEmployeeAndDate(emp.id, today);
        const missedItems: string[] = [];

        if (!plan) missedItems.push('daily_plan');
        if (entries.length === 0) missedItems.push('timesheet');

        if (missedItems.length > 0) {
          missedByEmployee.set(emp.employeeCode, {
            employeeName: emp.name,
            employeeCode: emp.employeeCode,
            department: emp.department,
            email: emp.email,
            missedItems,
          });
        }

        if (!plan) {
          missedDailyPlan.push({
            employeeName: emp.name,
            employeeCode: emp.employeeCode,
            department: emp.department,
            email: emp.email
          });
        }

        if (entries.length === 0) {
          missedTimesheet.push({
            employeeName: emp.name,
            employeeCode: emp.employeeCode,
            department: emp.department,
            email: emp.email
          });
        }
      }

      const { generateAndSendEODReport } = await import('./scheduler');
      await generateAndSendEODReport(today, 'Manual Alert');

      res.json({
        success: true,
        summary: {
          missedDailyPlan: missedDailyPlan.length,
          missedTimesheet: missedTimesheet.length,
          affectedEmployees: missedByEmployee.size,
        }
      });
    } catch (err) {
      console.error("[END OF DAY CHECK] Failed:", err);
      res.status(500).json({ error: "Failed to run missed submission check." });
    }
  });

  app.post("/api/daily-plans/deviations", async (req, res) => {
    try {
        const { employeeId, taskId, taskName, projectName, reason } = req.body;
        const date = new Date().toISOString().split('T')[0];
        const plan = await storage.getDailyPlanByDate(employeeId, date);
        if (!plan) return res.status(400).json({ error: "Plan for the day must be submitted first." });

        const existingTasks = await storage.getPlanTasks(plan.id);
        const deviationsCount = existingTasks.filter(t => t.isDeviation).length;
        if (deviationsCount >= 10) {
            return res.status(403).json({ error: "Maximum limit of 10 deviations per day reached. Please contact your manager if you need more." });
        }

        const task = await storage.createPlanTask({
            planId: plan.id,
            taskId,
            taskName,
            projectName,
            isDeviation: true,
            deviationReason: reason,
            status: 'pending' 
        });

        // Notify manager of deviation
        try {
          const { sendDeviationNotificationEmail } = await import('./email');
          const employee = await storage.getEmployee(employeeId);
          await sendDeviationNotificationEmail({
             employeeName: employee?.name || 'Employee',
             employeeCode: employee?.employeeCode || employeeId,
             taskName,
             projectName,
             reason
          });
        } catch (e) {
          console.error('[EMAIL] Deviation notification failed:', e);
        }

        broadcast("daily_plan_deviation", { task, employeeId });
        res.status(201).json(task);
    } catch (error) {
        console.error("Deviation error:", error);
        res.status(500).json({ error: "Failed to add deviation" });
    }
  });

  app.get("/api/pending-deadline-tasks", async (req, res) => {
    try {
      const { employeeId, date } = req.query;
      res.json([]); // Placeholder
    } catch (err) {
      res.status(500).json([]);
    }
  });

  app.get("/api/daily-plans/all", async (req, res) => {
    try {
      const plans = await storage.getAllDailyPlans();
      if (plans.length === 0) return res.json([]);

      const employeeIds = Array.from(new Set(plans.map(p => p.employeeId)));
      const planIds = plans.map(p => p.id);

      // 1. Batch fetch employees
      const employeeMap = new Map<string, any>();
      const allEmps = await storage.getEmployees();
      allEmps.forEach(e => employeeMap.set(e.id, e));

      // 2. Batch fetch plan tasks
      const tasksByPlan = new Map<string, any[]>();
      try {
        const allTasks = await storage.getBatchPlanTasksByPlanIds(planIds);
        allTasks.forEach(t => {
          const list = tasksByPlan.get(t.planId) || [];
          list.push(t);
          tasksByPlan.set(t.planId, list);
        });
      } catch (e) {
        console.error("Batch plan tasks fetch failed:", e);
      }

      // 3. Batch fetch postponements
      const postponementsByEmpDate = new Map<string, any[]>();
      try {
        const postRes = await pool.query(
          `SELECT task_name, reason, new_due_date, postponed_by, DATE(postponed_at)::text as p_date 
           FROM task_postponements 
           WHERE postponed_by = ANY($1::varchar[])`,
          [employeeIds]
        );
        postRes.rows.forEach(row => {
          const key = `${row.postponed_by}_${row.p_date}`;
          const list = postponementsByEmpDate.get(key) || [];
          list.push(row);
          postponementsByEmpDate.set(key, list);
        });
      } catch (e) {
        console.error("Batch postponements fetch failed:", e);
      }

      const enrichedPlans = plans.map(p => {
        const employee = employeeMap.get(p.employeeId);
        const tasks = tasksByPlan.get(p.id) || [];
        const postKey = `${p.employeeId}_${p.date}`;
        const postponedTasks = postponementsByEmpDate.get(postKey) || [];

        return {
          ...p,
          employeeName: employee?.name || 'Unknown',
          employeeCode: employee?.employeeCode || 'Unknown',
          tasks,
          postponedTasks
        };
      });

      res.json(enrichedPlans);
    } catch (error) {
      console.error("Get all daily plans error:", error);
      res.status(500).json({ error: "Failed to fetch daily plans" });
    }
  });

  app.patch("/api/daily-plans/tasks/:taskId/status", async (req, res) => {
     try {
       const { taskId } = req.params;
       const { status } = req.body; // 'approved' or 'rejected'
       await storage.updatePlanTask(taskId, { status });
       res.json({ success: true });
     } catch (error) {
       console.error("Update plan task status error:", error);
       res.status(500).json({ error: "Failed to update status" });
     }
  });

  // Get available PMS tasks grouped by project for the employee's department
  app.get("/api/available-tasks", async (req, res) => {
    try {
      const employeeId = req.query.employeeId as string;

      console.log("[AVAILABLE-TASKS] Request received for employee:", employeeId);

      if (!employeeId) {
        return res.status(400).json({ error: "Employee ID is required" });
      }

      // Get employee info to get department
      const employee = await storage.getEmployee(employeeId);
      if (!employee) {
        console.error("[AVAILABLE-TASKS] Employee not found in database:", employeeId);
        return res.status(404).json({ error: "Employee not found" });
      }

      console.log("[AVAILABLE-TASKS] Fetching for employee:", { 
        name: employee.name, 
        code: employee.employeeCode, 
        dept: employee.department,
        role: employee.role 
      });

      const userDepartment = employee.department || '';

      // Get projects for this employee's department
      const { getProjects } = await import('./pmsSupabase');
      const projects = await getProjects(employee.role, employee.employeeCode, userDepartment);
      console.log(`[AVAILABLE-TASKS] Found ${projects.length} projects for department "${userDepartment}"`);

      // Fetch tasks for each project and group them
      const { getTasks } = await import('./pmsSupabase');
      const tasksWithProjects: any[] = [];

      // Extract just YYYY-MM-DD from a date string to avoid UTC conversion issues.
      // E.g. "2026-04-16T00:00:00+05:30" → "2026-04-16" (no Date object created, no timezone shift)
      const extractDatePart = (dateStr: string | null | undefined): string | null => {
        if (!dateStr) return null;
        return String(dateStr).substring(0, 10); // Always "YYYY-MM-DD"
      };

      // Compute today's date in IST (UTC+5:30) so the server's UTC clock doesn't cause off-by-one day errors
      const getISTTodayKey = (): string => {
        const now = new Date();
        const utcNow = now.getTime() + (now.getTimezoneOffset() * 60000);
        const istNow = new Date(utcNow + (5.5 * 60 * 60 * 1000));
        return istNow.toISOString().split('T')[0];
      };
      const todayKey = getISTTodayKey();

      // Fetch all tasks for the department in a single query
      const { getDepartmentTasks } = await import('./pmsSupabase');
      const allProjectTasks = await getDepartmentTasks(userDepartment, employee.employeeCode, employee.role);
      
      console.log(`[AVAILABLE-TASKS] Found ${allProjectTasks.length} tasks across all projects`);

      for (const task of allProjectTasks) {
        const project = task.project;
        if (!project) continue;

        const projectKey = extractDatePart(project.end_date);
        const isProjectOverdue = projectKey ? projectKey < todayKey : false;
        const taskKey = extractDatePart(task.end_date);
        const isTaskOverdue = taskKey ? taskKey < todayKey : false;

        const isAutoSelected = shouldSyncPMSTask(task, todayKey);

        tasksWithProjects.push({
          ...task,
          projectCode: project.project_code,
          projectName: project.project_name,
          projectDescription: project.description,
          projectDeadline: project.end_date || null,
          taskDeadline: task.end_date || null,
          isProjectOverdue: isProjectOverdue || false,
          isTaskOverdue: isTaskOverdue || false,
          isOverdue: (isTaskOverdue || isProjectOverdue) ? true : false,
          source: "PMS",
          isLocked: isAutoSelected,
          isAutoSelected: isAutoSelected
        });
      }

      console.log(`[AVAILABLE-TASKS] Total tasks processed for ${employee.name}: ${tasksWithProjects.length}`);
      res.json(tasksWithProjects);
    } catch (error) {
      console.error("[AVAILABLE-TASKS] Error:", error);
      res.status(500).json({ error: "Failed to fetch available tasks", details: String(error) });
    }
  });

  // Get timesheet blocking settings
  app.get('/api/settings/timesheet-blocking', async (req, res) => {
    try {
      const settings = await readSettings();
      res.json({ blockUnassignedProjectTasks: !!settings.blockUnassignedProjectTasks });
    } catch (error) {
      console.error('Get settings error:', error);
      res.status(500).json({ error: 'Failed to get settings' });
    }
  });

  // Project points storage endpoints (safe: creates its own table if missing)
  app.get('/api/project-points/:projectId', async (req, res) => {
    try {
      const projectId = req.params.projectId;
      const { getProjectProgress } = await import('./pmsSupabase');

      // ensure table exists
      try {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS project_points (
            project_id text PRIMARY KEY,
            points integer NOT NULL DEFAULT 0,
            last_active timestamptz
          )`);
      } catch (e) { /* ignore */ }

      // SYNC WITH PMS: Fetch real-time progress from hierarchy
      const progress = await getProjectProgress(projectId);
      const targetPoints = Math.round(progress * 10);

      // Upsert into local points table
      await pool.query(
        `INSERT INTO project_points (project_id, points, last_active) 
         VALUES ($1, $2, COALESCE((SELECT last_active FROM project_points WHERE project_id = $1), NOW())) 
         ON CONFLICT (project_id) DO UPDATE SET points = EXCLUDED.points`,
        [projectId, targetPoints]
      );

      const q = await pool.query('SELECT project_id as "projectId", points, last_active as "lastActive" FROM project_points WHERE project_id = $1', [projectId]);
      if (q.rows && q.rows.length > 0) return res.json(q.rows[0]);
      return res.json({ projectId, points: targetPoints, lastActive: null });
    } catch (err) {
      console.error('Get project points error:', err);
      res.status(500).json({ error: 'Failed to fetch project points' });
    }
  });

  // Patch project points: body { delta?: number, set?: number, touchLastActive?: boolean }
  app.patch('/api/project-points/:projectId', async (req, res) => {
    try {
      const projectId = req.params.projectId;
      const { delta, set, touchLastActive } = req.body || {};

      try {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS project_points (
            project_id text PRIMARY KEY,
            points integer NOT NULL DEFAULT 0,
            last_active timestamptz
          )`);
      } catch (e) { /* ignore */ }

      // upsert logic
      if (typeof set === 'number') {
        await pool.query(`INSERT INTO project_points (project_id, points, last_active) VALUES ($1, $2, $3) ON CONFLICT (project_id) DO UPDATE SET points = EXCLUDED.points, last_active = EXCLUDED.last_active`, [projectId, Math.max(0, Math.floor(set)), touchLastActive ? new Date() : null]);
      } else if (typeof delta === 'number') {
        // update points by delta, clamp at 0
        const cur = await pool.query('SELECT points FROM project_points WHERE project_id = $1', [projectId]);
        const prev = (cur.rows && cur.rows[0] && typeof cur.rows[0].points === 'number') ? parseInt(cur.rows[0].points) : 0;
        const next = Math.max(0, prev + Math.floor(delta));
        await pool.query(`INSERT INTO project_points (project_id, points, last_active) VALUES ($1, $2, $3) ON CONFLICT (project_id) DO UPDATE SET points = $2, last_active = COALESCE($3, project_points.last_active)`, [projectId, next, touchLastActive ? new Date() : null]);
      } else {
        return res.status(400).json({ error: 'delta or set required' });
      }

      const q = await pool.query('SELECT project_id as "projectId", points, last_active as "lastActive" FROM project_points WHERE project_id = $1', [projectId]);
      return res.json(q.rows && q.rows[0] ? q.rows[0] : { projectId, points: 0, lastActive: null });
    } catch (err) {
      console.error('Patch project points error:', err);
      res.status(500).json({ error: 'Failed to update project points' });
    }
  });

  // Update timesheet blocking settings
  app.patch('/api/settings/timesheet-blocking', async (req, res) => {
    try {
      const { blockUnassignedProjectTasks } = req.body;
      const settings = await readSettings();
      settings.blockUnassignedProjectTasks = !!blockUnassignedProjectTasks;
      const success = await writeSettings(settings);
      if (!success) {
        return res.status(500).json({ error: 'Failed to write settings' });
      }
      res.json({ blockUnassignedProjectTasks: !!settings.blockUnassignedProjectTasks });
    } catch (error) {
      console.error('Update settings error:', error);
      res.status(500).json({ error: 'Failed to update settings' });
    }
  });

  // Toggle force allow final submit (E0046, E0048 only)
  app.patch('/api/settings/force-allow-final-submit', async (req, res) => {
    try {
      const { employeeId, enabled } = req.body;
      const actor = await storage.getEmployee(employeeId);
      if (!actor || (actor.employeeCode !== 'E0046' && actor.employeeCode !== 'E0048')) {
        return res.status(403).json({ error: 'Unauthorized. Only E0046 and E0048 can toggle this setting.' });
      }
      const settings = await readSettings();
      settings.forceAllowFinalSubmit = !!enabled;
      const success = await writeSettings(settings);
      if (!success) {
        return res.status(500).json({ error: 'Failed to write settings' });
      }
      broadcast('force_allow_final_submit_changed', { enabled: !!enabled, changedBy: actor.name });
      res.json({ success: true, settings });
    } catch (err) {
      console.error('[SETTINGS] Failed to toggle force allow final submit:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Get settings
  app.get('/api/settings', async (req, res) => {
    try {
      const settings = await readSettings();
      res.json(settings);
    } catch (err) {
      console.error('[SETTINGS] Failed to read settings:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ============ EOD REPORTS ROUTE ============
  app.get("/api/reports/eod", async (req, res) => {
    try {
      const { date, startDate, endDate } = req.query;
      
      let targetDates: string[] = [];
      let rangeStart: string;
      let rangeEnd: string;

      if (startDate && endDate) {
        rangeStart = startDate as string;
        rangeEnd = endDate as string;
        const start = parseISO(rangeStart);
        const end = parseISO(rangeEnd);
        targetDates = eachDayOfInterval({ start, end }).map(d => format(d, 'yyyy-MM-dd'));
      } else if (date) {
        rangeStart = date as string;
        rangeEnd = date as string;
        targetDates = [date as string];
      } else {
        return res.status(400).json({ error: "Date or date range is required" });
      }

      const { getBatchLMSHours } = await import('./lmsSupabase');

      // Optimization: Batch fetch all required data in parallel
      const [
        allEmployees,
        flatEntries,
        flatSubs,
        batchLMS,
        batchPlanTasks
      ] = await Promise.all([
        storage.getEmployees(),
        storage.getTimeEntriesByDateRange(rangeStart, rangeEnd),
        storage.getDailySubmissionsByDateRange(rangeStart, rangeEnd),
        getBatchLMSHours(rangeStart, rangeEnd),
        storage.getBatchPlanTasksByDateRange(rangeStart, rangeEnd)
      ]);
      
      const parseDurationToMinutes = (duration: string): number => {
        if (!duration) return 0;
        const hMatch = duration.match(/(\d+)h/);
        const mMatch = duration.match(/(\d+)m/);
        const colonMatch = duration.match(/(\d+):(\d+)/);
        
        if (hMatch || mMatch) {
          const h = hMatch ? parseInt(hMatch[1], 10) : 0;
          const m = mMatch ? parseInt(mMatch[1], 10) : 0;
          return h * 60 + m;
        } else if (colonMatch) {
          return parseInt(colonMatch[1], 10) * 60 + parseInt(colonMatch[2], 10);
        }
        const digits = parseFloat(duration);
        if (!isNaN(digits)) return digits * 60;
        return 0;
      };

      const finalReport: any[] = [];

      for (const dStr of targetDates) {
        const dateEntries = flatEntries.filter(e => e.date === dStr);
        const dailySubs = flatSubs.filter(s => s.date === dStr);
        
        for (const emp of allEmployees) {
          if (emp.role === 'admin' && emp.employeeCode === 'ADMIN') continue; 

          // Check batch LMS data
          const lmsData = batchLMS[emp.employeeCode]?.[dStr] || {
            leaveHours: 0,
            permissionHours: 0,
            totalLMSHours: 0,
            details: { leaves: [], permissions: [] }
          };
          
          const hasLeave = lmsData.leaveHours >= 4; 
          const isFullLeave = lmsData.leaveHours >= 8;

          // Check if final submitted
          const isFinalSubmitted = dailySubs.some(s => s.employeeId === emp.id);

          const empEntries = dateEntries.filter(e => 
            e.employeeId === emp.id || 
            (e.employeeCode && e.employeeCode.toUpperCase() === emp.employeeCode.toUpperCase())
          );

          // Get planned projects from batchPlanTasks
          let plannedProjects: string[] = [];
          if (empEntries.length === 0) {
            const empPlanTasks = batchPlanTasks.filter(pt => 
              pt.daily_plans.employeeId === emp.id && 
              pt.daily_plans.date === dStr
            );
            plannedProjects = Array.from(new Set(empPlanTasks.map(pt => pt.plan_tasks.projectName)));
          }
          
          const totalMinutes = empEntries.reduce((sum, entry) => sum + parseDurationToMinutes(entry.totalHours), 0);
          const totalHours = totalMinutes / 60;
          
          const isSunday = parseISO(dStr).getDay() === 0;
          
          let status = "Not Submitted";
          if (isFinalSubmitted) {
            status = "Submitted";
          } else if (isFullLeave) {
            status = "On Leave";
          } else if (empEntries.length > 0) {
            status = "Incomplete";
          } else if (hasLeave) {
            status = "On Leave"; 
          } else if (isSunday) {
            status = "Sunday";
          }

          let remark = "";
          if (status === "Submitted") remark = "Final timesheet submitted.";
          else if (status === "Sunday") remark = "Weekly Holiday (Sunday).";
          else if (status === "On Leave") remark = `Employee on approved leave (${lmsData.leaveHours}h).`;
          else if (status === "Incomplete") remark = `Draft entries exist (${totalHours.toFixed(1)}h), but final submission missing.`;
          else remark = "No timesheet entries or leave found.";

          finalReport.push({
            employeeId: emp.id,
            employeeName: emp.name,
            employeeCode: emp.employeeCode,
            email: emp.email || "N/A",
            department: emp.department || "N/A",
            date: dStr,
            status,
            workingHours: totalHours.toFixed(1),
            lmsHours: (lmsData.totalLMSHours || 0).toFixed(1),
            requiredHours: 8,
            remark,
            entries: empEntries,
            plannedProjects
          });
        }
      }

      res.json(finalReport);
    } catch (error) {
      console.error("EOD Report error:", error);
      res.status(500).json({ error: "Failed to fetch EOD report" });
    }
  });

  // ============ ALERTS ROUTES ============
  app.get("/api/alerts/:employeeId", async (req, res) => {
    try {
      const alerts = await storage.getAlertsByEmployee(req.params.employeeId);
      res.json(alerts);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch alerts" });
    }
  });

  app.post("/api/alerts/:id/read", async (req, res) => {
    try {
      await storage.markAlertAsRead(req.params.id);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to mark alert as read" });
    }
  });

  return httpServer;
}
