# AXM WebApp V2.2

AXM Automatic Xerox Machine web application.

## Run on Windows

1. Install Node.js LTS.
2. Open Command Prompt in this folder.
3. Run:
   npm install
   npm start
4. Open http://localhost:3000 on the PC.

## Phone testing on the same Wi-Fi

The server listens on `0.0.0.0`, so the phone can use the PC's LAN IP, for example:

http://192.168.x.x:3000/machine.html

Do not use `localhost` in a QR code for a phone.

## Important

The V2.2 package includes the complete document upload, options, amount calculation, payment state and print-job workflow. The `TEST PAYMENT SUCCESS` button is deliberately a development-only control.

For real payments, Razorpay Order creation + webhook/signature verification must be added and the real printer agent must run on the Windows machine. Never put the Razorpay secret in browser JavaScript or commit it to GitHub.
