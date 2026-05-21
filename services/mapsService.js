// import fetch from "node-fetch";

// const GOOGLE_API = "https://maps.googleapis.com/maps/api/distancematrix/json";

// // Your 5 hub addresses
// const HUBS = [
//   "Law College Rd, Erandwane, Pune, Maharashtra 411004, India",
//   "City woods, Salisbury Park, Pune, Maharashtra 411037, India",
//   "Fortaleza Complex, Kalyani Nagar, Pune, Maharashtra 411006, India",
//   "Satara Rd, Pune, Maharashtra 411037, India",
//   "ICC Towers, Senapati Bapat Rd, Pune, Maharashtra 411016, India",
// ];

// // Pick nearest hub + ETA
// export async function calculateETA(destination) {
//   const key = process.env.GOOGLE_MAPS_API_KEY;
//   if (!key) throw new Error("Missing GOOGLE_MAPS_API_KEY");

//   const results = [];

//   for (const hub of HUBS) {
//     const url = `${GOOGLE_API}?origins=${encodeURIComponent(
//       hub
//     )}&destinations=${encodeURIComponent(
//       destination
//     )}&mode=driving&departure_time=now&traffic_model=best_guess&key=${key}`;

//     const res = await fetch(url);
//     const data = await res.json();

//     if (data.rows?.[0]?.elements?.[0]?.status === "OK") {
//       const el = data.rows[0].elements[0];
//       results.push({
//         hub,
//         distance_m: el.distance.value,
//         duration_s: el.duration_in_traffic?.value || el.duration.value,
//       });
//     }
//   }

//   if (results.length === 0) throw new Error("No routes found");

//   // Pick the fastest hub
//   results.sort((a, b) => a.duration_s - b.duration_s);
//   const best = results[0];

//   return {
//     hub: best.hub,
//     distance_km: (best.distance_m / 1000).toFixed(1),
//     duration_min: Math.round(best.duration_s / 60),
//   };
// }
