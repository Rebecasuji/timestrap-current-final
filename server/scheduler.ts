
import cron from "node-cron";
import { storage } from "./storage";
import { getTasks } from "./pmsSupabase";
import { getLMSHours } from "./lmsSupabase";
import { sendDailyPlanReminderEmail, sendEODSummaryReportEmail, sendPortalClosedNotificationEmail, sendEmail } from "./email";
import { format, subDays } from "date-fns";

/**
 * Initialize all scheduled tasks
 */
export function initScheduler() {
  console.log("[SCHEDULER] Automated alert/EOD cron jobs are disabled. Manual alert buttons must be used.");
}

/**
 * Send reminders to all employees to fill their Plan for the Day
 */
async function sendMorningReminders() {
  try {
    const employees = await storage.getEmployees();
    const activeEmployees = employees.filter(e => e.isActive && e.role !== 'admin');
    const today = format(new Date(), "yyyy-MM-dd");

    for (const emp of activeEmployees) {
      if (!emp.email) continue;
      const existingPlan = await storage.getDailyPlanByDate(emp.id, today);
      if (existingPlan) continue;

      const pendingTasks = await getTasks(undefined, undefined, emp.employeeCode);
      const taskNames = pendingTasks.map(t => t.task_name);

      await sendDailyPlanReminderEmail({
        recipients: [emp.email],
        pendingTasks: taskNames
      });
    }
  } catch (error) {
    console.error("[SCHEDULER] Morning reminders failed:", error);
  }
}

/**
 * Generic function to generate EOD report and send to admins
 * Returns result status for tracking purposes
 */
export async function generateAndSendEODReport(dateStr: string, reportType: string) {
  try {
    console.log(`[EOD REPORT] Starting ${reportType} report generation for ${dateStr}`);
    const employees = await storage.getEmployees();
    const dateEntries = await storage.getTimeEntriesByDate(dateStr);
    const dailySubs = await storage.getDailySubmissionsByDate(dateStr);

    const reportData = [];
    const missingEmployees = [];
    let emailsAttempted = 0;
    let emailsSent = 0;
    const emailErrors = [];

    for (const emp of employees) {
      if (emp.role === 'admin' && emp.employeeCode === 'ADMIN') continue;
      if (!emp.isActive) continue;

      const lmsData = await getLMSHours(emp.employeeCode, dateStr);
      const isFullLeave = lmsData.leaveHours >= 8;
      const isFinalSubmitted = dailySubs.some(s => s.employeeId === emp.id);
      const empEntries = dateEntries.filter(e => e.employeeId === emp.id);
      
      let status = "Missing";
      if (isFinalSubmitted) status = "Submitted";
      else if (isFullLeave) status = "On Leave";
      else if (empEntries.length > 0) status = "Incomplete";

      if (status === "Missing" || status === "Incomplete") {
        missingEmployees.push(emp);
        
        // Only trigger in-app alerts at Noon
        if (reportType.includes("Noon")) {
          try {
            await storage.createAlert({
              employeeId: emp.id,
              type: status === "Missing" ? "missing_submission" : "late_submission",
              message: status === "Missing" 
                ? `You missed your timesheet submission for ${dateStr}.` 
                : `Your timesheet for ${dateStr} is incomplete and portal is now closed.`,
              date: dateStr
            });
          } catch (alertErr) {
            console.error(`[EOD REPORT] Failed to create alert for ${emp.employeeCode}:`, alertErr);
          }
        }
      }

      reportData.push({
        name: emp.name,
        code: emp.employeeCode,
        dept: emp.department || "N/A",
        status,
        hours: isFinalSubmitted ? dailySubs.find(s => s.employeeId === emp.id)?.totalHours : "0"
      });
    }

    const admins = employees.filter(e => e.role === 'admin' || e.role === 'hr');
    const adminEmails = admins.map(a => a.email).filter(Boolean) as string[];

    console.log(`[EOD REPORT] Generated report data - Total: ${reportData.length}, Missing/Incomplete: ${missingEmployees.length}, Admins to notify: ${adminEmails.length}`);

    if (adminEmails.length > 0) {
      const reportRows = reportData.map(r => `
        <tr style="border-bottom: 1px solid #e2e8f0;">
          <td style="padding: 16px; border-bottom: 1px solid #f1f5f9;">
            <div style="font-weight: 700; color: #0f172a;">${r.name}</div>
            <div style="font-size: 11px; color: #64748b;">${r.code}</div>
          </td>
          <td style="padding: 16px; border-bottom: 1px solid #f1f5f9; color: #475569; font-size: 13px;">${r.dept}</td>
          <td style="padding: 16px; border-bottom: 1px solid #f1f5f9;">
            <span style="font-size: 11px; font-weight: 700; padding: 4px 8px; border-radius: 6px; text-transform: uppercase; ${
              r.status === 'Submitted' ? 'background: #dcfce7; color: #166534;' : 
              r.status === 'On Leave' ? 'background: #dbeafe; color: #1e40af;' : 
              'background: #fee2e2; color: #991b1b;'
            }">${r.status}</span>
          </td>
          <td style="padding: 16px; border-bottom: 1px solid #f1f5f9; text-align: center; font-weight: 700; color: #0f172a;">${r.hours}h</td>
        </tr>
      `).join('');

      emailsAttempted++;
      const eodEmailResult = await sendEODSummaryReportEmail({
        recipients: adminEmails,
        date: dateStr,
        summary: {
          total: reportData.length,
          submitted: reportData.filter(r => r.status === 'Submitted').length,
          missing: missingEmployees.length,
          onLeave: reportData.filter(r => r.status === 'On Leave').length
        },
        reportRows
      });

      if (eodEmailResult.success) {
        emailsSent++;
        console.log(`[EOD REPORT] ✓ EOD summary email sent to admins (${adminEmails.join(', ')})`);
      } else {
        console.error(`[EOD REPORT] ✗ Failed to send EOD summary email:`, eodEmailResult.error);
        emailErrors.push({ recipient: 'admins', error: eodEmailResult.error });
      }
    } else {
      console.warn(`[EOD REPORT] No admin/HR emails found to send EOD report`);
    }

    // Send closing alert email to missing employees only at Noon
    if (reportType.includes("Noon")) {
      const missingEmails = missingEmployees.map(e => e.email).filter(Boolean) as string[];
      if (missingEmails.length > 0) {
        emailsAttempted++;
        // For simplicity, we'll indicate both items as missing when the portal closes
        const closingEmailResult = await sendPortalClosedNotificationEmail({
          recipients: missingEmails,
          missedSubmissionType: 'both',
          date: dateStr
        });

        if (closingEmailResult.success) {
          emailsSent++;
          console.log(`[EOD REPORT] ✓ Portal closure notification sent to ${missingEmails.length} missing employees`);
        } else {
          console.error(`[EOD REPORT] ✗ Failed to send portal closure notifications:`, closingEmailResult.error);
          emailErrors.push({ recipient: 'missing-employees', count: missingEmails.length, error: closingEmailResult.error });
        }
      }
    }

    console.log(`[EOD REPORT] Completed - Emails sent: ${emailsSent}/${emailsAttempted}, Errors: ${emailErrors.length}`);

    return {
      success: emailErrors.length === 0,
      reportType,
      date: dateStr,
      summary: {
        totalEmployees: reportData.length,
        submitted: reportData.filter(r => r.status === 'Submitted').length,
        incomplete: reportData.filter(r => r.status === 'Incomplete').length,
        missing: missingEmployees.length,
        onLeave: reportData.filter(r => r.status === 'On Leave').length
      },
      emails: {
        attempted: emailsAttempted,
        sent: emailsSent,
        errors: emailErrors
      }
    };
  } catch (error) {
    console.error(`[EOD REPORT] ${reportType} report failed:`, error);
    return {
      success: false,
      reportType,
      error: error instanceof Error ? error.message : 'unknown error',
      date: dateStr
    };
  }
}
