const axios = require('axios');
async function test() {
  try {
    const res = await axios.get('http://localhost:5001/api/inventory/medicines', {
      headers: {
        Authorization: 'Bearer eyJhbGciOiJFUzI1NiIsImtpZCI6ImVlMTgwMTFmLWNjZTMtNGIwZC1iMmU2LTNmM2Y4YWY0OWFjNyIsInR5cCI6IkpXVCJ9.eyJpZCI6IjM3YWQ4ZTAyLTI2NzUtNGNmMS1iNGQ2LTlmN2UzOTViNWZhOCIsImNsaW5pY19pZCI6ImMxMDAwMDAwLTAwMDAtMDAwMC0wMDAwLTAwMDAwMDAwMDAwMSIsImVtYWlsIjoiMjVlMDAxLm5leHN5cnVzQGdtYWlsLmNvbSIsInJvbGUiOiJvd25lciIsImlhdCI6MTc0MDIxMTU3NCwiZXhwIjoxNzcxNzQ3NTc0LCJpc3MiOiJtZWRpY2FsLXBvcy1hdXRoIiwic3ViIjoiMzdhZDhlMDItMjY3NS00Y2YxLWI0ZDYtOWY3ZTM5NWI1ZmE4In0.1mXz51T9Y460k-R0Vl6V_2O8x1e7h3D5wG_hM4G1p7e9d7c4D9C8x3E2a1B0f5A9D2e6C5b8F7A1E4d0C3B2A1'
      }
    });
    console.log('Status:', res.status);
    console.log('Data typeof:', typeof res.data);
    console.log('Data keys:', Object.keys(res.data));
    console.log('IsArray(res.data.data):', Array.isArray(res.data.data));
    console.log('Data length:', res.data.data?.length);
  } catch (err) {
    console.error('Error:', err.message, err.response?.data);
  }
}
test();
