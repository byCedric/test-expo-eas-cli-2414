import process from 'node:process';

/** Max memory used, in bytes */
let memoryMaxUsage = 0;

// On every tick, monitor the memory
process.nextTick(() => {
  const memoryCurrentUsage = process.memoryUsage.rss();

  if (memoryCurrentUsage > memoryMaxUsage) {
    memoryMaxUsage = memoryCurrentUsage;
  }
});

// When finished, log the max memory used
process.on('exit', () => {
  console.log('Memory max usage: ', memoryMaxUsage / 1024 / 1024, 'MB');
});
