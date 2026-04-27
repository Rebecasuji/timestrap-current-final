import "dotenv/config";
import pkg from 'pg';
const { Pool } = pkg;
import type { QueryResult } from 'pg';

// LMS Database URL from environment variables
const lmsDatabaseUrl = process.env.LMS_DATABASE_URL;

if (!lmsDatabaseUrl) {
  console.warn('⚠️ LMS_DATABASE_URL is not defined in environment variables.');
} else {
  console.log(`📡 LMS Database connection initialized (URL starts with: ${lmsDatabaseUrl.substring(0, 20)}...)`);
}

export const lmsPool = new Pool({
  connectionString: lmsDatabaseUrl,
  ssl: {
    rejectUnauthorized: false
  }
});

export interface LMSHours {
  leaveHours: number;
  permissionHours: number;
  totalLMSHours: number;
  details: {
    leaves: any[];
    permissions: any[];
  };
}

/**
 * Fetches approved leave and permission hours for multiple employees over a date range.
 * This is significantly faster for reporting.
 */
export const getBatchLMSHours = async (startDate: string, endDate: string): Promise<Record<string, Record<string, LMSHours>>> => {
  try {
    console.log(`🔍 Batch fetching LMS hours from ${startDate} to ${endDate}`);

    // 1. Fetch Approved Leaves for all employees in range
    const leaveQuery = `
      SELECT user_id, start_date, end_date, leave_duration_type, status
      FROM leaves
      WHERE status = 'Approved'
        AND (
          (start_date::date <= $2::date AND end_date::date >= $1::date)
        )
    `;
    const leaveResult: QueryResult = await lmsPool.query(leaveQuery, [startDate, endDate]);

    // 2. Fetch Approved Permissions for all employees in range
    const permissionQuery = `
      SELECT user_id, total_hours, status, permission_date
      FROM permissions
      WHERE status = 'Approved'
        AND permission_date::date >= $1::date
        AND permission_date::date <= $2::date
    `;
    const permissionResult: QueryResult = await lmsPool.query(permissionQuery, [startDate, endDate]);

    // Initialize result structure: { [empCode]: { [date]: LMSHours } }
    const result: Record<string, Record<string, LMSHours>> = {};

    // Helper to ensure path exists
    const ensurePath = (empCode: string, dStr: string) => {
      if (!result[empCode]) result[empCode] = {};
      if (!result[empCode][dStr]) {
        result[empCode][dStr] = {
          leaveHours: 0,
          permissionHours: 0,
          totalLMSHours: 0,
          details: { leaves: [], permissions: [] }
        };
      }
    };

    // Process Leaves
    const { eachDayOfInterval, parseISO, format: dFormat } = await import('date-fns');
    const start = parseISO(startDate);
    const end = parseISO(endDate);
    const rangeDates = eachDayOfInterval({ start, end }).map(d => dFormat(d, 'yyyy-MM-dd'));

    leaveResult.rows.forEach(row => {
      const empCode = row.user_id;
      const lStart = dFormat(new Date(row.start_date), 'yyyy-MM-dd');
      const lEnd = dFormat(new Date(row.end_date), 'yyyy-MM-dd');
      
      // Filter rangeDates to see which fall within this leave
      rangeDates.forEach(dStr => {
        if (dStr >= lStart && dStr <= lEnd) {
          ensurePath(empCode, dStr);
          const hours = row.leave_duration_type === 'Full Day' ? 8 : (row.leave_duration_type === 'Half Day' ? 4 : 0);
          result[empCode][dStr].leaveHours += hours;
          result[empCode][dStr].totalLMSHours += hours;
          result[empCode][dStr].details.leaves.push(row);
        }
      });
    });

    // Process Permissions
    permissionResult.rows.forEach(row => {
      const empCode = row.user_id;
      const dStr = dFormat(new Date(row.permission_date), 'yyyy-MM-dd');
      
      if (dStr >= startDate && dStr <= endDate) {
        ensurePath(empCode, dStr);
        const hours = parseFloat(row.total_hours) || 0;
        result[empCode][dStr].permissionHours += hours;
        result[empCode][dStr].totalLMSHours += hours;
        result[empCode][dStr].details.permissions.push(row);
      }
    });

    return result;
  } catch (error) {
    console.error('💥 Error batch fetching LMS hours:', error);
    return {};
  }
};

/**
 * Fetches approved leave and permission hours for an employee on a specific date.
 */
export const getLMSHours = async (employeeCode: string, date: string): Promise<LMSHours> => {
  try {
    const batch = await getBatchLMSHours(date, date);
    return batch[employeeCode]?.[date] || {
      leaveHours: 0,
      permissionHours: 0,
      totalLMSHours: 0,
      details: { leaves: [], permissions: [] }
    };
  } catch (error) {
    console.error('💥 Error fetching LMS hours:', error);
    return {
      leaveHours: 0,
      permissionHours: 0,
      totalLMSHours: 0,
      details: { leaves: [], permissions: [] }
    };
  }
};
