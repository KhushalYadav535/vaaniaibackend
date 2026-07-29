const fs = require('fs');

function cleanFile(file) {
  let content = fs.readFileSync(file, 'utf8');

  // Remove ALL injected ALAC strings
  const injected1 = / , \.\.\.\(req\.user\.accountType === 'member' && req\.user\.restrictAgents \? \{ agentId: \{ \$in: req\.user\.assignedAgents \|\| \[\] \} \} : \{\}\)/g;
  const injected2 = / , \.\.\.\(req\.user\.accountType === 'member' && req\.user\.restrictAgents \? \{ _id: \{ \$in: req\.user\.assignedAgents \|\| \[\] \} \} : \{\}\)/g;
  const injected3 = /, \.\.\.\(req\.user\.accountType === 'member' && req\.user\.restrictAgents \? \{ agentId: \{ \$in: req\.user\.assignedAgents \|\| \[\] \} \} : \{\}\)/g;

  content = content.replace(injected1, '');
  content = content.replace(injected2, '');
  content = content.replace(injected3, '');

  fs.writeFileSync(file, content);
}

['d:/vaaniai/vaaniaibackend/routes/analytics.js', 'd:/vaaniai/vaaniaibackend/routes/calls.js'].forEach(cleanFile);
console.log('Cleaned files');
