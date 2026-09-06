AXM V3 — CLOUD READY

IMPORTANT:
A laptop-local server cannot be reached by customers over mobile data. V3 is prepared to run on a public HTTPS server.

LOCAL TEST:
1. Install Node.js LTS.
2. Open Command Prompt in this folder.
3. Run: npm install
4. Run: npm start
5. Open http://localhost:3000

PUBLIC TEST:
Deploy this folder to a Node.js hosting service that provides a public HTTPS URL.
Set environment variable BASE_URL to that HTTPS URL if the host's generated URL is not automatically detected.
The QR then points to the public upload website, so customers do not need to join the AXM Wi-Fi.

IMPORTANT:
The local version cannot magically become public just by changing JavaScript. A public server/domain is required for real customers.

NEXT:
V3.1 = persistent database/storage and job expiry
V3.2 = PDF page count + B&W/Colour + single/double side + pricing
V4 = real payment gateway/webhook
V5 = printer control
