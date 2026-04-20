
import { db } from '../server/db';
import { employees, timeEntries } from '../shared/schema';
import { eq } from 'drizzle-orm';

async function checkEODData() {
  const date = '2026-04-15';
  console.log(`🔍 Checking EOD data for ${date}...`);
  
  const allEmps = await db.select().from(employees);
  const entries = await db.select().from(timeEntries).where(eq(timeEntries.date, date));
  
  console.log(`Total Employees: ${allEmps.length}`);
  console.log(`Total Entries for date: ${entries.length}`);
  
  const rebeca = allEmps.find(e => e.employeeCode === 'E0046');
  if (rebeca) {
    console.log(`✅ Found Rebecasuji: ID=${rebeca.id}`);
    const rebecaEntries = entries.filter(e => e.employeeId === rebeca.id || e.employeeCode === 'E0046');
    console.log(`   Rebeca Entries found: ${rebecaEntries.length}`);
    let totalMinutes = 0;
    rebecaEntries.forEach(e => {
      const match = e.totalHours.match(/(\d+)h\s*(\d+)m/);
      if (match) {
        totalMinutes += parseInt(match[1]) * 60 + parseInt(match[2]);
      } else {
        const justM = e.totalHours.match(/(\d+)m/);
        if (justM) totalMinutes += parseInt(justM[1]);
      }
    });
    console.log(`   Total Summed: ${Math.floor(totalMinutes/60)}h ${totalMinutes%60}m`);
  } else {
    console.log(`❌ Rebecasuji (E0046) NOT FOUND in employees table`);
  }
  
  process.exit(0);
}

checkEODData();
