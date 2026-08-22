export function getCycleTimes() {
  const now = new Date();
  
  // Calculate next 15-minute boundary
  const currentMinutes = now.getUTCMinutes();
  const remainder = 15 - (currentMinutes % 15);
  
  const entryDate = new Date(now.getTime() + remainder * 60000);
  entryDate.setUTCSeconds(0, 0);
  
  const closeDate = new Date(entryDate.getTime() + 15 * 60000);
  
  const todayDateStr = new Date(now.getTime() + 3600000).toISOString().split('T')[0];

  return {
    entryTimestamp: Math.floor(entryDate.getTime() / 1000),
    closeTimestamp: Math.floor(closeDate.getTime() / 1000),
    entryTimeFormatted: formatWAT(entryDate),
    closeTimeFormatted: formatWAT(closeDate),
    todayDateStr
  };
}

export function formatWAT(date) {
  // Add 1 hour for UTC+1 (Nigeria Time)
  const watDate = new Date(date.getTime() + 3600000);
  let hours = watDate.getUTCHours();
  const minutes = watDate.getUTCMinutes().toString().padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `${hours}:${minutes} ${ampm}`;
}

