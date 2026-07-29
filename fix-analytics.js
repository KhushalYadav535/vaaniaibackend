const fs = require('fs');

function fixFile(file, models) {
  let content = fs.readFileSync(file, 'utf8');

  // Replace req.user._id with req.effectiveUserId
  content = content.replace(/req\.user\._id/g, 'req.effectiveUserId');

  // Helper to inject ALAC
  const injectALAC = (model, field = 'agentId') => {
    // Fix countDocuments
    const regex = new RegExp(model + '\\.countDocuments\\(\\{ userId\\b(.*?)\\}\\)', 'g');
    content = content.replace(regex, (match, p1) => {
      return `${model}.countDocuments({ userId${p1}, ...(req.user.accountType === 'member' && req.user.restrictAgents ? { ${field}: { $in: req.user.assignedAgents || [] } } : {}) })`;
    });
    
    // Fix aggregate
    const regex2 = new RegExp(model + '\\.aggregate\\(\\[\\s*\\{ \\$match: \\{ userId\\b(.*?)\\} \\}', 'g');
    content = content.replace(regex2, (match, p1) => {
      return `${model}.aggregate([\n      { $match: { userId${p1}, ...(req.user.accountType === 'member' && req.user.restrictAgents ? { ${field}: { $in: req.user.assignedAgents || [] } } : {}) } }`;
    });

    // Fix find
    const regex3 = new RegExp(model + '\\.find\\(\\{ userId\\b(.*?)\\}\\)', 'g');
    content = content.replace(regex3, (match, p1) => {
      return `${model}.find({ userId${p1}, ...(req.user.accountType === 'member' && req.user.restrictAgents ? { ${field}: { $in: req.user.assignedAgents || [] } } : {}) })`;
    });
  };

  models.forEach(m => injectALAC(m.name, m.field));

  fs.writeFileSync(file, content);
  console.log('Fixed', file);
}

fixFile('d:/vaaniai/vaaniaibackend/routes/analytics.js', [
  { name: 'Agent', field: '_id' },
  { name: 'CallLog', field: 'agentId' }
]);

fixFile('d:/vaaniai/vaaniaibackend/routes/calls.js', [
  { name: 'Agent', field: '_id' },
  { name: 'CallLog', field: 'agentId' }
]);

fixFile('d:/vaaniai/vaaniaibackend/routes/numbers.js', [
  { name: 'Number', field: 'agentId' } // numbers aren't typically restricted by agentId but let's just do effectiveUserId
]);
