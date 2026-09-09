const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const QRCode = require("qrcode");
const Razorpay = require("razorpay");
const { PDFDocument } = require("pdf-lib");

const app = express();

const PORT = process.env.PORT || 10000;

// ============================================================
// DIRECTORIES
// ============================================================

const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");

fs.mkdirSync(UPLOAD_DIR, {
    recursive: true
});

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(express.json({
    limit: "10mb"
}));

app.use(express.urlencoded({
    extended: true
}));

app.use(express.static(__dirname));

// ============================================================
// FILE UPLOAD
// ============================================================

const storage = multer.diskStorage({

    destination: function (req, file, cb) {
        cb(null, UPLOAD_DIR);
    },

    filename: function (req, file, cb) {

        const safeName =
            path.basename(file.originalname)
                .replace(/[^a-zA-Z0-9._-]/g, "_");

        const uniqueName =
            Date.now() +
            "_" +
            crypto.randomBytes(6).toString("hex") +
            "_" +
            safeName;

        cb(null, uniqueName);
    }
});

const upload = multer({

    storage: storage,

    limits: {
        fileSize: 25 * 1024 * 1024
    },

    fileFilter: function (req, file, cb) {

        const allowedTypes = [
            "application/pdf",
            "image/jpeg",
            "image/png",
            "image/webp"
        ];

        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(
                new Error(
                    "Only PDF, JPG, PNG and WEBP files are allowed."
                )
            );
        }
    }
});

// ============================================================
// RAZORPAY
// ============================================================

const RAZORPAY_KEY_ID =
    process.env.RAZORPAY_KEY_ID;

const RAZORPAY_KEY_SECRET =
    process.env.RAZORPAY_KEY_SECRET;

let razorpay = null;

if (
    RAZORPAY_KEY_ID &&
    RAZORPAY_KEY_SECRET
) {

    razorpay = new Razorpay({

        key_id: RAZORPAY_KEY_ID,

        key_secret: RAZORPAY_KEY_SECRET

    });

    console.log("Razorpay: CONFIGURED");

} else {

    console.log("Razorpay: NOT CONFIGURED");
}

// ============================================================
// AXM SESSION
// ============================================================

let activeSession = {

    token: null,

    createdAt: 0

};

const SESSION_TIME =
    30 * 60 * 1000;

// ============================================================
// CURRENT JOB
// ============================================================

let currentJob = null;

// ============================================================
// EVENTS
// ============================================================

let eventId = 0;

const events = [];

function addEvent(data) {

    eventId++;

    const event = {

        id: eventId,

        time: Date.now(),

        ...data

    };

    events.push(event);

    if (events.length > 100) {
        events.shift();
    }

    console.log(
        "EVENT:",
        event.type
    );

    return event;
}

// ============================================================
// BASE URL
// ============================================================

function getBaseUrl(req) {

    const forwardedProto =
        req.headers["x-forwarded-proto"];

    const protocol =
        forwardedProto ||
        req.protocol ||
        "https";

    const forwardedHost =
        req.headers["x-forwarded-host"];

    const host =
        forwardedHost ||
        req.get("host");

    return `${protocol}://${host}`;
}

// ============================================================
// HOME
// ============================================================

app.get("/", function (req, res) {

    res.sendFile(
        path.join(__dirname, "index.html")
    );

});

// ============================================================
// HEALTH
// ============================================================

app.get("/api/health", function (req, res) {

    const sessionValid =
        activeSession.token &&
        Date.now() -
        activeSession.createdAt <
        SESSION_TIME;

    res.json({

        success: true,

        status: "online",

        machine: "NIET AXM",

        razorpay:
            !!razorpay,

        razorpayConfigured:
            !!razorpay,

        activeSession:
            !!sessionValid,

        activeSessions:
            sessionValid ? 1 : 0,

        job:
            !!currentJob,

        timestamp:
            Date.now()

    });

});

// ============================================================
// PAYMENT CONFIG
// ============================================================

app.get(
    "/api/payment-config",
    function (req, res) {

        res.json({

            success: true,

            configured:
                !!razorpay,

            key_id:
                RAZORPAY_KEY_ID || null

        });

    }
);

// ============================================================
// GENERATE MACHINE QR
// ============================================================

app.get(
    "/api/machine-qr",
    async function (req, res) {

        try {

            const token =
                crypto
                    .randomBytes(32)
                    .toString("hex");

            activeSession = {

                token:
                    token,

                createdAt:
                    Date.now()

            };

            /*
             * A new QR also starts a new machine session.
             */

            currentJob = null;

            const uploadUrl =
                getBaseUrl(req) +
                "/upload.html?token=" +
                encodeURIComponent(token);

            console.log(
                "================================"
            );

            console.log(
                "NEW NIET AXM SESSION CREATED"
            );

            console.log(
                "TOKEN:",
                token
            );

            console.log(
                "UPLOAD URL:",
                uploadUrl
            );

            console.log(
                "================================"
            );

            const qr =
                await QRCode.toDataURL(
                    uploadUrl,
                    {

                        width:
                            350,

                        margin:
                            2,

                        errorCorrectionLevel:
                            "M"

                    }
                );

            res.json({

                success:
                    true,

                qr:
                    qr,

                uploadUrl:
                    uploadUrl

            });

        } catch (error) {

            console.error(
                "QR ERROR:",
                error
            );

            res.status(500).json({

                success:
                    false,

                error:
                    "Unable to generate QR code."

            });

        }

    }
);

// ============================================================
// CHECK SESSION
// ============================================================

app.get(
    "/api/session-check",
    function (req, res) {

        const token =
            req.query.token;

        if (!token) {

            return res.json({

                success:
                    true,

                active:
                    false

            });

        }

        const valid =
            activeSession.token === token &&
            Date.now() -
            activeSession.createdAt <
            SESSION_TIME;

        res.json({

            success:
                true,

            active:
                valid

        });

    }
);

// ============================================================
// AUTOMATIC PDF PAGE DETECTION
// ============================================================

async function getDocumentPageCount(
    filePath,
    mimetype
) {

    /*
     * PDF:
     * Read the PDF and count its actual pages.
     */

    if (
        mimetype ===
        "application/pdf"
    ) {

        const pdfBytes =
            fs.readFileSync(
                filePath
            );

        const pdfDoc =
            await PDFDocument.load(
                pdfBytes,
                {
                    ignoreEncryption:
                        true
                }
            );

        return pdfDoc.getPageCount();
    }

    /*
     * Images are treated as one printable page.
     */

    if (
        mimetype === "image/jpeg" ||
        mimetype === "image/png" ||
        mimetype === "image/webp"
    ) {

        return 1;

    }

    return 1;
}

// ============================================================
// UPLOAD DOCUMENT
// ============================================================

app.post(
    "/api/upload",
    upload.single("document"),
    async function (req, res) {

        try {

            console.log(
                "UPLOAD REQUEST RECEIVED"
            );

            const token =
                req.query.token ||
                req.body.token ||
                req.headers["x-axm-token"];

            console.log(
                "UPLOAD TOKEN:",
                token
                    ? "PRESENT"
                    : "MISSING"
            );

            // ------------------------------------------------
            // Validate session
            // ------------------------------------------------

            if (!token) {

                return res.status(403).json({

                    success:
                        false,

                    error:
                        "No AXM session token. Please scan a new QR code."

                });

            }

            if (
                !activeSession.token ||
                token !== activeSession.token
            ) {

                return res.status(403).json({

                    success:
                        false,

                    error:
                        "No active AXM session. Please scan a new QR code."

                });

            }

            if (
                Date.now() -
                activeSession.createdAt >
                SESSION_TIME
            ) {

                activeSession = {

                    token:
                        null,

                    createdAt:
                        0

                };

                return res.status(403).json({

                    success:
                        false,

                    error:
                        "AXM session expired. Please scan a new QR code."

                });

            }

            // ------------------------------------------------
            // Validate file
            // ------------------------------------------------

            if (!req.file) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        "No document was uploaded."

                });

            }

            // ------------------------------------------------
            // AUTOMATIC PAGE COUNT
            // ------------------------------------------------

            let pages;

            try {

                pages =
                    await getDocumentPageCount(
                        req.file.path,
                        req.file.mimetype
                    );

            } catch (pdfError) {

                console.error(
                    "PAGE COUNT ERROR:",
                    pdfError
                );

                /*
                 * Delete broken upload.
                 */

                try {
                    fs.unlinkSync(
                        req.file.path
                    );
                } catch (_) {}

                return res.status(400).json({

                    success:
                        false,

                    error:
                        "Unable to read the document. Please upload a valid PDF."

                });

            }

            if (
                !Number.isFinite(pages) ||
                pages < 1
            ) {

                pages = 1;

            }

            pages =
                Math.floor(pages);

            // ------------------------------------------------
            // CREATE JOB
            // ------------------------------------------------

            currentJob = {

                id:
                    crypto
                        .randomBytes(12)
                        .toString("hex"),

                filename:
                    req.file.originalname,

                storedFile:
                    req.file.filename,

                filepath:
                    req.file.path,

                mimetype:
                    req.file.mimetype,

                size:
                    req.file.size,

                status:
                    "RECEIVED",

                colour:
                    "Black & White",

                sides:
                    "Single Side",

                pages:
                    pages,

                copies:
                    1,

                amount:
                    pages * 2,

                paymentStatus:
                    "PENDING",

                createdAt:
                    Date.now(),

                sessionToken:
                    token

            };

            console.log(
                "DOCUMENT RECEIVED:",
                currentJob.filename
            );

            console.log(
                "AUTOMATIC PAGE COUNT:",
                currentJob.pages
            );

            addEvent({

                type:
                    "document_received",

                job:
                    currentJob

            });

            return res.status(200).json({

                success:
                    true,

                message:
                    "Document uploaded successfully to NIET AXM.",

                job:
                    currentJob

            });

        } catch (error) {

            console.error(
                "UPLOAD ERROR:",
                error
            );

            return res.status(500).json({

                success:
                    false,

                error:
                    error.message ||
                    "Document upload failed."

            });

        }

    }
);

// ============================================================
// CURRENT JOB
// ============================================================

app.get(
    "/api/current-job",
    function (req, res) {

        res.json({

            success:
                true,

            job:
                currentJob

        });

    }
);

// ============================================================
// JOB
// ============================================================

app.get(
    "/api/job",
    function (req, res) {

        res.json({

            success:
                true,

            job:
                currentJob

        });

    }
);

// ============================================================
// EVENTS
// ============================================================

app.get(
    "/api/events",
    function (req, res) {

        try {

            const since =
                Number(
                    req.query.since || 0
                );

            const result =
                events.filter(
                    function (event) {

                        return event.id >
                            since;

                    }
                );

            res.json(result);

        } catch (error) {

            console.error(
                "EVENT ERROR:",
                error
            );

            res.status(500).json({

                success:
                    false,

                error:
                    "Unable to read events."

            });

        }

    }
);

// ============================================================
// SAVE PRINT OPTIONS
// ============================================================

app.post(
    "/api/options",
    function (req, res) {

        try {

            if (!currentJob) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        "No document has been received yet."

                });

            }

            const colour =
                req.body.colour ||
                req.body.color ||
                "Black & White";

            const sides =
                req.body.sides ||
                "Single Side";

            /*
             * PAGE COUNT IS NEVER TAKEN FROM USER INPUT.
             *
             * It was detected automatically during upload.
             */

            const pages =
                Number(
                    currentJob.pages
                );

            let copies =
                Number(
                    req.body.copies || 1
                );

            if (
                !Number.isFinite(copies) ||
                copies < 1
            ) {

                copies = 1;

            }

            copies =
                Math.floor(copies);

            // ------------------------------------------------
            // PRICING
            // ------------------------------------------------

            let rate = 2;

            if (
                colour ===
                "Black & White" &&
                sides ===
                "Single Side"
            ) {

                rate = 2;

            } else if (
                colour ===
                "Black & White" &&
                sides ===
                "Double Side"
            ) {

                rate = 3;

            } else if (
                colour ===
                "Colour" &&
                sides ===
                "Single Side"
            ) {

                rate = 5;

            } else if (
                colour ===
                "Colour" &&
                sides ===
                "Double Side"
            ) {

                rate = 10;

            }

            const amount =
                pages *
                copies *
                rate;

            currentJob.colour =
                colour;

            currentJob.sides =
                sides;

            currentJob.pages =
                pages;

            currentJob.copies =
                copies;

            currentJob.rate =
                rate;

            currentJob.amount =
                amount;

            currentJob.status =
                "OPTIONS_SELECTED";

            currentJob.paymentStatus =
                "PENDING";

            addEvent({

                type:
                    "options_selected",

                job:
                    currentJob

            });

            console.log(
                "PRINT OPTIONS:",
                colour,
                sides
            );

            console.log(
                "PAGES:",
                pages
            );

            console.log(
                "COPIES:",
                copies
            );

            console.log(
                "RATE:",
                rate
            );

            console.log(
                "TOTAL:",
                amount
            );

            res.json({

                success:
                    true,

                message:
                    "Print options saved.",

                job:
                    currentJob,

                amount:
                    amount,

                rate:
                    rate

            });

        } catch (error) {

            console.error(
                "OPTIONS ERROR:",
                error
            );

            res.status(500).json({

                success:
                    false,

                error:
                    "Unable to save print options."

            });

        }

    }
);

// ============================================================
// CREATE RAZORPAY ORDER
// ============================================================

app.post(
    "/api/create-order",
    async function (req, res) {

        try {

            if (!razorpay) {

                return res.status(500).json({

                    success:
                        false,

                    error:
                        "Razorpay is not configured on the server."

                });

            }

            if (!currentJob) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        "No print job available."

                });

            }

            const amount =
                Number(
                    currentJob.amount
                );

            if (
                !Number.isFinite(amount) ||
                amount <= 0
            ) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        "Invalid payment amount."

                });

            }

            const order =
                await razorpay.orders.create({

                    amount:
                        Math.round(
                            amount * 100
                        ),

                    currency:
                        "INR",

                    receipt:
                        "NIETAXM_" +
                        Date.now(),

                    notes: {

                        project:
                            "NIET AXM",

                        job_id:
                            currentJob.id,

                        pages:
                            String(
                                currentJob.pages
                            ),

                        copies:
                            String(
                                currentJob.copies
                            ),

                        colour:
                            currentJob.colour,

                        sides:
                            currentJob.sides

                    }

                });

            currentJob.razorpayOrderId =
                order.id;

            currentJob.status =
                "PAYMENT_STARTED";

            console.log(
                "RAZORPAY ORDER CREATED:",
                order.id
            );

            res.json({

                success:
                    true,

                keyId:
                    RAZORPAY_KEY_ID,

                key_id:
                    RAZORPAY_KEY_ID,

                orderId:
                    order.id,

                order_id:
                    order.id,

                amount:
                    order.amount,

                currency:
                    order.currency,

                order:
                    order

            });

        } catch (error) {

            console.error(
                "RAZORPAY ORDER ERROR:",
                error
            );

            res.status(500).json({

                success:
                    false,

                error:
                    error.error?.description ||
                    error.message ||
                    "Unable to create Razorpay order."

            });

        }

    }
);

// ============================================================
// VERIFY RAZORPAY PAYMENT
// ============================================================

app.post(
    "/api/verify-payment",
    function (req, res) {

        try {

            const {

                razorpay_order_id,

                razorpay_payment_id,

                razorpay_signature

            } = req.body;

            if (
                !razorpay_order_id ||
                !razorpay_payment_id ||
                !razorpay_signature
            ) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        "Missing Razorpay payment details."

                });

            }

            if (!RAZORPAY_KEY_SECRET) {

                return res.status(500).json({

                    success:
                        false,

                    error:
                        "Razorpay secret is not configured."

                });

            }

            const body =
                razorpay_order_id +
                "|" +
                razorpay_payment_id;

            const expectedSignature =
                crypto
                    .createHmac(
                        "sha256",
                        RAZORPAY_KEY_SECRET
                    )
                    .update(body)
                    .digest("hex");

            const valid =
                crypto.timingSafeEqual(
                    Buffer.from(
                        expectedSignature
                    ),
                    Buffer.from(
                        razorpay_signature
                    )
                );

            if (!valid) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        "Payment verification failed."

                });

            }

            /*
             * Make sure the payment belongs
             * to the current Razorpay order.
             */

            if (
                currentJob &&
                currentJob.razorpayOrderId &&
                currentJob.razorpayOrderId !==
                razorpay_order_id
            ) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        "Payment order does not match the current print job."

                });

            }

            if (currentJob) {

                currentJob.paymentStatus =
                    "PAID";

                currentJob.status =
                    "PAYMENT_SUCCESS";

                currentJob.razorpayPaymentId =
                    razorpay_payment_id;

                currentJob.razorpayOrderId =
                    razorpay_order_id;

                addEvent({

                    type:
                        "payment_success",

                    job:
                        currentJob

                });

            }

            console.log(
                "PAYMENT VERIFIED:",
                razorpay_payment_id
            );

            res.json({

                success:
                    true,

                message:
                    "Payment verified successfully.",

                payment_id:
                    razorpay_payment_id,

                order_id:
                    razorpay_order_id,

                job:
                    currentJob

            });

        } catch (error) {

            console.error(
                "PAYMENT VERIFY ERROR:",
                error
            );

            res.status(500).json({

                success:
                    false,

                error:
                    "Payment verification failed."

            });

        }

    }
);

// ============================================================
// TEST PAYMENT
// ============================================================

app.post(
    "/api/test-payment",
    function (req, res) {

        try {

            if (!currentJob) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        "No print job available."

                });

            }

            currentJob.paymentStatus =
                "PAID";

            currentJob.status =
                "PAYMENT_SUCCESS";

            currentJob.testPayment =
                true;

            addEvent({

                type:
                    "payment_success",

                job:
                    currentJob

            });

            res.json({

                success:
                    true,

                message:
                    "Test payment successful.",

                amount:
                    currentJob.amount,

                job:
                    currentJob

            });

        } catch (error) {

            res.status(500).json({

                success:
                    false,

                error:
                    "Test payment failed."

            });

        }

    }
);

// ============================================================
// PRINT
// ============================================================

app.post(
    "/api/print",
    function (req, res) {

        try {

            if (!currentJob) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        "No print job available."

                });

            }

            if (
                currentJob.paymentStatus !==
                "PAID"
            ) {

                return res.status(403).json({

                    success:
                        false,

                    error:
                        "Payment is required before printing."

                });

            }

            currentJob.status =
                "PRINTING";

            addEvent({

                type:
                    "printing",

                job:
                    currentJob

            });

            console.log(
                "PRINT JOB:",
                currentJob.filename
            );

            res.json({

                success:
                    true,

                message:
                    "Print job is ready.",

                job:
                    currentJob,

                printUrl:
                    "/print.html"

            });

        } catch (error) {

            console.error(
                "PRINT ERROR:",
                error
            );

            res.status(500).json({

                success:
                    false,

                error:
                    "Unable to start printing."

            });

        }

    }
);

// ============================================================
// RESET
// ============================================================

app.post(
    "/api/reset",
    function (req, res) {

        /*
         * Delete uploaded file after job completion.
         */

        if (
            currentJob &&
            currentJob.filepath
        ) {

            try {

                if (
                    fs.existsSync(
                        currentJob.filepath
                    )
                ) {

                    fs.unlinkSync(
                        currentJob.filepath
                    );

                }

            } catch (error) {

                console.error(
                    "FILE DELETE ERROR:",
                    error
                );

            }

        }

        currentJob =
            null;

        activeSession = {

            token:
                null,

            createdAt:
                0

        };

        addEvent({

            type:
                "machine_reset"

        });

        res.json({

            success:
                true,

            message:
                "NIET AXM machine reset."

        });

    }
);

// ============================================================
// MULTER / SERVER ERROR HANDLER
// ============================================================

app.use(
    function (error, req, res, next) {

        console.error(
            "SERVER ERROR:",
            error
        );

        if (
            req.path ===
            "/api/upload"
        ) {

            return res.status(400).json({

                success:
                    false,

                error:
                    error.message ||
                    "Upload failed."

            });

        }

        res.status(500).json({

            success:
                false,

            error:
                error.message ||
                "Server error."

        });

    }
);

// ============================================================
// API 404
// ============================================================

app.use(
    "/api",
    function (req, res) {

        res.status(404).json({

            success:
                false,

            error:
                "API endpoint not found: " +
                req.method +
                " " +
                req.originalUrl

        });

    }
);

// ============================================================
// START SERVER
// ============================================================

app.listen(
    PORT,
    "0.0.0.0",
    function () {

        console.log(
            "=========================================="
        );

        console.log(
            "NIET AXM SERVER IS RUNNING"
        );

        console.log(
            "PORT:",
            PORT
        );

        console.log(
            "RAZORPAY:",
            razorpay
                ? "CONFIGURED"
                : "NOT CONFIGURED"
        );

        console.log(
            "AUTOMATIC PDF PAGE DETECTION: ENABLED"
        );

        console.log(
            "=========================================="
        );

    }
);
