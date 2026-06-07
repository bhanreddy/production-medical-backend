const axios = require('axios');
async function test() {
  try {
    const res = await axios.get('http://localhost:5001/api/inventory/medicines');
    console.log(JSON.stringify(res.data, null, 2).substring(0, 500));
  } catch (err) {
    console.error('Error:', err.message);
  }
}
test();
