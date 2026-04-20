
import { db } from '../server/db';
import { employees } from '../shared/schema';
import { eq, or } from 'drizzle-orm';

async function deleteEmployees() {
  console.log('🗑️ Deleting requested employees from database...');
  
  try {
    const deleted = await db.delete(employees)
      .where(or(
        eq(employees.employeeCode, 'E0054'), // KIRUBA
        eq(employees.employeeCode, 'E0052'), // Jyothsna Priya
        eq(employees.employeeCode, 'E0028')  // Kaalipushpa R
      ))
      .returning();
    
    console.log(`✅ Successfully deleted ${deleted.length} employees:`);
    deleted.forEach(emp => console.log(` - ${emp.name} (${emp.employeeCode})`));
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error deleting employees:', error);
    process.exit(1);
  }
}

deleteEmployees();
