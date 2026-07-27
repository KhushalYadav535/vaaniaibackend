const mongoose = require('mongoose');

mongoose.connect('mongodb://admin:vJUm4yLOD8eUZsBqtdGJYU47JsJFe8rO@213.210.37.237:32768/vaanidb?authSource=admin');

mongoose.connection.once('open', async () => {
  const db = mongoose.connection.db;

  const targets = [/अनुराग/i, /optical/i, /niict/i];
  let found = [];
  for (const pattern of targets) {
    const agents = await db.collection('agents').find({ name: pattern }).toArray();
    agents.forEach(a => found.push(a));
  }

  console.log('Found agents to delete:');
  found.forEach(a => console.log(' ID:', a._id, '| Name:', a.name));

  if (found.length === 0) {
    console.log('No matching agents found!');
    process.exit(0);
  }

  const ids = found.map(a => a._id);
  const result = await db.collection('agents').deleteMany({ _id: { $in: ids } });
  console.log('✅ Deleted count:', result.deletedCount);
  process.exit(0);
});
