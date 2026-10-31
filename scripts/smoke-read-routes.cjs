const fs = require('node:fs');
const { routeManifest } = require('./route-manifest.cjs');
const target = new URL(process.env.QA_API_URL || 'http://127.0.0.1:5001');
if (!['127.0.0.1', 'localhost'].includes(target.hostname)) throw new Error('Route smoke tests only run against localhost.');
const credential = JSON.parse(fs.readFileSync(process.env.QA_AUTH_FILE, 'utf8'));
const query = {
  '/api/barcodes/lookup': '?code=QA-SMOKE',
  '/api/organizations/inventory/reconciliation': '?batch_id=11111111-1111-4111-8111-111111111111',
  '/api/master/search': '?q=QA',
  ...(process.env.QA_QUERY_FILE ? JSON.parse(fs.readFileSync(process.env.QA_QUERY_FILE,'utf8')) : {}),
};
(async () => {
  const results = [];
  const paths = [...new Set(routeManifest().filter(route => route.method === 'GET' && !route.path.includes(':') && !route.path.endsWith('/events/stream')).map(route => route.path))];
  for (const path of paths) {
    const start = performance.now();
    try {
      const response = await fetch(new URL(path + (query[path] || ''), target), { headers: {Authorization: `Bearer ${credential.access_token}`}, signal: AbortSignal.timeout(20000) });
      const body = await response.text();
      results.push({ path, status: response.status, ms: Math.round(performance.now() - start), ...(response.ok ? {} : {error: body.slice(0,250)}) });
    } catch (error) { results.push({path,status:0,error:error.message}); }
  }
  if (process.env.QA_RESULTS_FILE) fs.writeFileSync(process.env.QA_RESULTS_FILE, JSON.stringify(results,null,2));
  console.log(JSON.stringify({checked:results.length,passed:results.filter(r=>r.status===200).length,denied:results.filter(r=>[400,401,403,404].includes(r.status)),blocked:results.filter(r=>r.path==='/api/superadmin/shops'&&r.status===503),failures:results.filter(r=>(r.status>=500||r.status===0)&&!(r.path==='/api/superadmin/shops'&&r.status===503&&r.error?.includes('auth is not configured')))},null,2));
  if (results.some(r=>(r.status>=500||r.status===0)&&!(r.path==='/api/superadmin/shops'&&r.status===503&&r.error?.includes('auth is not configured')))) process.exitCode=1;
})();
