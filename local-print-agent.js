
const fs = require("fs");
const path = require("path");
const os = require("os");
const { print, getPrinters } = require("pdf-to-printer");

// AXM Windows Local Print Agent
// Runs on your Windows laptop, not on Render.

const SERVER_URL = (process.env.AXM_SERVER_URL || "").replace(/\/+$/, "");
const AGENT_TOKEN = process.env.AXM_AGENT_TOKEN || "";
const PRINTER_NAME = process.env.AXM_PRINTER_NAME || "Canon G2010";

const DOWNLOAD_DIR = path.join(os.tmpdir(), "AXM-Print-Jobs");

const POLL_INTERVAL = 5000;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function apiRequest(endpoint, options = {}) {
    const response = await fetch(`${SERVER_URL}${endpoint}`, {
        ...options,
        headers: {
            Authorization: `Bearer ${AGENT_TOKEN}`,
            ...(options.headers || {})
        }
    });

    if (!response.ok) {
        const message = await response.text();
        throw new Error(`Server error ${response.status}: ${message}`);
    }

    return response;
}

async function reportResult(jobId, success, error = "") {
    const response = await apiRequest("/api/agent/complete", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            jobId,
            success,
            error
        })
    });

    return response.json();
}

async function downloadDocument(job) {
    const response = await apiRequest(job.downloadPath);

    const filePath = path.join(
        DOWNLOAD_DIR,
        `AXM-${job.jobId}.pdf`
    );

    const buffer = Buffer.from(await response.arrayBuffer());

    if (!buffer.length || buffer.subarray(0, 5).toString() !== "%PDF-") {
        throw new Error("Downloaded document is not a valid PDF.");
    }

    fs.writeFileSync(filePath, buffer);

    return filePath;
}

async function processJob(job) {
    console.log("\nNew paid print job:", job.jobId);
    console.log("Document:", job.filename);

    let filePath = null;

    try {
        filePath = await downloadDocument(job);

        const printers = await getPrinters();

        const selectedPrinter = printers.find(printer =>
            printer.name.toLowerCase().includes(PRINTER_NAME.toLowerCase())
        );

        if (!selectedPrinter) {
            throw new Error(
                `Printer "${PRINTER_NAME}" not found. Available printers: ` +
                printers.map(p => p.name).join(", ")
            );
        }

        console.log("Printer:", selectedPrinter.name);
        console.log("Copies:", job.copies || 1);
        console.log("Sending PDF to Windows printer...");

        await print(filePath, {
            printer: selectedPrinter.name,
            copies: Math.max(1, Number(job.copies) || 1)
        });

        await reportResult(job.jobId, true);

        console.log("Print command submitted to Windows successfully.");
        console.log("Check the printer for the actual printed pages.");

    } catch (error) {
        console.error("PRINT ERROR:", error.message);

        try {
            await reportResult(job.jobId, false, error.message);
        } catch (reportError) {
            console.error("Could not report print failure:", reportError.message);
        }

    } finally {
        if (filePath && fs.existsSync(filePath)) {
            try {
                fs.unlinkSync(filePath);
            } catch (error) {
                console.error("Temporary file cleanup failed:", error.message);
            }
        }
    }
}

async function startAgent() {
    if (process.platform !== "win32") {
        throw new Error("AXM Print Agent must run on Windows.");
    }

    if (!SERVER_URL || !AGENT_TOKEN) {
        throw new Error(
            "Set AXM_SERVER_URL and AXM_AGENT_TOKEN before starting the agent."
        );
    }

    if (AGENT_TOKEN.length < 32) {
        throw new Error("AXM_AGENT_TOKEN must contain at least 32 characters.");
    }

    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

    console.log("====================================");
    console.log("AXM WINDOWS PRINT AGENT");
    console.log("Server:", SERVER_URL);
    console.log("Printer search:", PRINTER_NAME);
    console.log("====================================");

    const printers = await getPrinters();

    console.log("Available Windows printers:");
    printers.forEach(printer => console.log("-", printer.name));

    while (true) {
        try {
            const response = await apiRequest("/api/agent/next-job");
            const data = await response.json();

            if (data.job) {
                await processJob(data.job);
            } else {
                await sleep(POLL_INTERVAL);
            }

        } catch (error) {
            console.error("Agent connection error:", error.message);
            await sleep(POLL_INTERVAL);
        }
    }
}

startAgent().catch(error => {
    console.error("AXM AGENT FAILED:", error.message);
    process.exit(1);
});

