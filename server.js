const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const QRCode = require("qrcode");
const Razorpay = require("razorpay");
const { execFileSync } = require("child_process");

const app = express();

const PORT = process.env.PORT || 10000;


/* ============================================================
   DIRECTORIES
   ============================================================ */

const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");

fs.mkdirSync(UPLOAD_DIR, {
    recursive: true
});


/* ============================================================
   MIDDLEWARE
   ============================================================ */

app.use(
    express.json({
        limit: "10mb"
    })
);

app.use(
    express.urlencoded({
        extended: true
    })
);

app.use(
    express.static(__dirname)
);


/* ============================================================
   FILE UPLOAD
   ============================================================ */

const storage = multer.diskStorage({

    destination: function(req, file, cb) {

        cb(
            null,
            UPLOAD_DIR
        );

    },

    filename: function(req, file, cb) {

        const safeName =
            path
                .basename(file.originalname)
                .replace(
                    /[^a-zA-Z0-9._-]/g,
                    "_"
                );

        const uniqueName =
            Date.now() +
            "_" +
            crypto
                .randomBytes(6)
                .toString("hex") +
            "_" +
            safeName;

        cb(
            null,
            uniqueName
        );

    }

});


const upload = multer({

    storage: storage,

    limits: {

        fileSize:
            25 * 1024 * 1024

    },

    fileFilter: function(req, file, cb) {

        const allowedTypes = [

            "application/pdf",

            "image/jpeg",

            "image/png",

            "image/webp"

        ];

        if (
            allowedTypes.includes(
                file.mimetype
            )
        ) {

            cb(
                null,
                true
            );

        }

        else {

            cb(
                new Error(
                    "Only PDF, JPG, PNG and WEBP files are allowed."
                )
            );

        }

    }

});


/* ============================================================
   PDF PAGE COUNT
   ============================================================ */

/*
 * This function detects the REAL number of pages
 * inside a PDF.
 *
 * Example:
 *
 * 1 page PDF  -> 1
 * 10 page PDF -> 10
 * 30 page PDF -> 30
 *
 * First it tries pdfinfo if available.
 * If pdfinfo is not available, it uses a PDF
 * object parser fallback.
 */

function getPdfPageCount(filePath) {

    if (!fs.existsSync(filePath)) {

        throw new Error(
            "Uploaded PDF file was not found."
        );

    }


    /* ========================================================
       METHOD 1
       pdfinfo
       ======================================================== */

    try {

        const output =
            execFileSync(
                "pdfinfo",
                [filePath],
                {
                    encoding: "utf8",
                    stdio: [
                        "ignore",
                        "pipe",
                        "ignore"
                    ]
                }
            );


        const match =
            output.match(
                /^Pages:\s+(\d+)/im
            );


        if (match) {

            const pages =
                Number(match[1]);


            if (
                Number.isInteger(pages) &&
                pages > 0
            ) {

                console.log(
                    "PDF PAGE COUNT:",
                    pages,
                    "(pdfinfo)"
                );

                return pages;

            }

        }

    }

    catch (error) {

        console.log(
            "pdfinfo not available. Using PDF parser fallback."
        );

    }


    /* ========================================================
       METHOD 2
       PDF OBJECT PARSER
       ======================================================== */

    const buffer =
        fs.readFileSync(
            filePath
        );


    const pdfText =
        buffer.toString(
            "latin1"
        );


    /*
     * Count real PDF page objects.
     *
     * /Type /Page
     *
     * is different from:
     *
     * /Type /Pages
     *
     * because of the word boundary.
     */

    const matches =
        pdfText.match(
            /\/Type\s*\/Page\b/g
        );


    const pages =
        matches
            ? matches.length
            : 0;


    if (
        !Number.isInteger(pages) ||
        pages < 1
    ) {

        throw new Error(
            "Unable to detect the number of pages in this PDF."
        );

    }


    console.log(
        "PDF PAGE COUNT:",
        pages,
        "(PDF parser)"
    );


    return pages;

}


/* ============================================================
   DETECT DOCUMENT PAGES
   ============================================================ */

function detectDocumentPages(
    filePath,
    mimetype
) {

    /*
     * PDF
     */

    if (
        mimetype ===
        "application/pdf"
    ) {

        return getPdfPageCount(
            filePath
        );

    }


    /*
     * Images are one printable page.
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


/* ============================================================
   RAZORPAY
   ============================================================ */

const RAZORPAY_KEY_ID =
    process.env.RAZORPAY_KEY_ID;

const RAZORPAY_KEY_SECRET =
    process.env.RAZORPAY_KEY_SECRET;


let razorpay = null;


if (
    RAZORPAY_KEY_ID &&
    RAZORPAY_KEY_SECRET
) {

    razorpay =
        new Razorpay({

            key_id:
                RAZORPAY_KEY_ID,

            key_secret:
                RAZORPAY_KEY_SECRET

        });


    console.log(
        "Razorpay: CONFIGURED"
    );

}

else {

    console.log(
        "Razorpay: NOT CONFIGURED"
    );

}


/* ============================================================
   SESSION
   ============================================================ */

let activeSession = {

    token:
        null,

    createdAt:
        0

};


const SESSION_TIME =
    30 * 60 * 1000;


/* ============================================================
   CURRENT JOB
   ============================================================ */

let currentJob =
    null;


/* ============================================================
   EVENTS
   ============================================================ */

let eventId =
    0;

const events =
    [];


function addEvent(data) {

    eventId++;


    const event = {

        id:
            eventId,

        time:
            Date.now(),

        ...data

    };


    events.push(
        event
    );


    if (
        events.length > 100
    ) {

        events.shift();

    }


    console.log(
        "EVENT:",
        event.type
    );


    return event;

}


/* ============================================================
   BASE URL
   ============================================================ */

function getBaseUrl(req) {

    const forwardedProto =
        req.headers[
            "x-forwarded-proto"
        ];

    const protocol =
        forwardedProto ||
        req.protocol ||
        "https";

    const forwardedHost =
        req.headers[
            "x-forwarded-host"
        ];

    const host =
        forwardedHost ||
        req.get("host");

    return (
        protocol +
        "://" +
        host
    );

}


/* ============================================================
   PRINT RATE
   ============================================================ */

function getPrintRate(
    colour,
    sides
) {

    const colourText =
        String(
            colour ||
            "Black & White"
        ).toLowerCase();


    const sidesText =
        String(
            sides ||
            "Single Side"
        ).toLowerCase();


    /* ========================================================
       B&W SINGLE SIDE
       ₹3
       ======================================================== */

    if (
        colourText.includes("black") &&
        sidesText.includes("single")
    ) {

        return 3;

    }


    /* ========================================================
       B&W DOUBLE SIDE
       ₹1.80
       ======================================================== */

    if (
        colourText.includes("black") &&
        sidesText.includes("double")
    ) {

        return 1.80;

    }


    /* ========================================================
       COLOUR SINGLE SIDE
       ₹5
       ======================================================== */

    if (
        (
            colourText.includes("colour") ||
            colourText.includes("color")
        ) &&
        sidesText.includes("single")
    ) {

        return 5;

    }


    /* ========================================================
       COLOUR DOUBLE SIDE
       ₹10
       ======================================================== */

    if (
        (
            colourText.includes("colour") ||
            colourText.includes("color")
        ) &&
        sidesText.includes("double")
    ) {

        return 10;

    }


    return 3;

}


/* ============================================================
   CALCULATE PRINT AMOUNT
   ============================================================ */

function calculatePrintAmount(
    pages,
    copies,
    colour,
    sides
) {

    const safePages =
        Math.max(
            1,
            Math.floor(
                Number(pages) || 1
            )
        );


    const safeCopies =
        Math.max(
            1,
            Math.floor(
                Number(copies) || 1
            )
        );


    const rate =
        getPrintRate(
            colour,
            sides
        );


    const amount =
        safePages *
        safeCopies *
        rate;


    return Math.round(
        amount * 100
    ) / 100;

}


/* ============================================================
   PHYSICAL SHEETS
   ============================================================ */

/*
 * Single side:
 *
 * 30 pages = 30 sheets
 *
 * Double side:
 *
 * 30 pages = 15 sheets
 *
 * 31 pages = 16 sheets
 */

function calculateSheets(
    pages,
    sides
) {

    const safePages =
        Math.max(
            1,
            Math.floor(
                Number(pages) || 1
            )
        );


    const sidesText =
        String(
            sides || ""
        ).toLowerCase();


    if (
        sidesText.includes("double")
    ) {

        return Math.ceil(
            safePages / 2
        );

    }


    return safePages;

}


/* ============================================================
   HOME
   ============================================================ */

app.get(
    "/",
    function(req, res) {

        res.sendFile(
            path.join(
                __dirname,
                "index.html"
            )
        );

    }
);


/* ============================================================
   HEALTH
   ============================================================ */

app.get(
    "/api/health",
    function(req, res) {

        const sessionValid =
            activeSession.token &&
            Date.now() -
            activeSession.createdAt <
            SESSION_TIME;


        res.json({

            success:
                true,

            status:
                "online",

            razorpay:
                !!razorpay,

            razorpayConfigured:
                !!razorpay,

            activeSession:
                !!sessionValid,

            activeSessions:
                sessionValid
                    ? 1
                    : 0,

            job:
                !!currentJob,

            timestamp:
                Date.now()

        });

    }
);


/* ============================================================
   PAYMENT CONFIG
   ============================================================ */

app.get(
    "/api/payment-config",
    function(req, res) {

        res.json({

            success:
                true,

            configured:
                !!razorpay,

            key_id:
                RAZORPAY_KEY_ID ||
                null

        });

    }
);


/* ============================================================
   MACHINE QR
   ============================================================ */

app.get(
    "/api/machine-qr",
    async function(req, res) {

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


            const uploadUrl =
                getBaseUrl(req) +
                "/upload.html?token=" +
                encodeURIComponent(
                    token
                );


            console.log(
                "NEW AXM SESSION CREATED"
            );


            console.log(
                "UPLOAD URL:",
                uploadUrl
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

        }

        catch (error) {

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


/* ============================================================
   SESSION CHECK
   ============================================================ */

app.get(
    "/api/session-check",
    function(req, res) {

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
            activeSession.token ===
                token &&
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


/* ============================================================
   UPLOAD DOCUMENT
   ============================================================ */

app.post(
    "/api/upload",
    upload.single("document"),
    function(req, res) {

        try {

            const token =
                req.query.token ||
                req.body.token ||
                req.headers[
                    "x-axm-token"
                ];


            /* ==================================================
               SESSION CHECK
               ================================================== */

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
                token !==
                    activeSession.token
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


            /* ==================================================
               FILE CHECK
               ================================================== */

            if (!req.file) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        "No document was uploaded."

                });

            }


            /* ==================================================
               REAL PAGE DETECTION
               ================================================== */

            let detectedPages;


            try {

                detectedPages =
                    detectDocumentPages(
                        req.file.path,
                        req.file.mimetype
                    );

            }

            catch (pageError) {

                console.error(
                    "PAGE DETECTION ERROR:",
                    pageError
                );


                /*
                 * Delete bad upload.
                 */

                try {

                    fs.unlinkSync(
                        req.file.path
                    );

                }

                catch (deleteError) {

                    console.error(
                        "FILE DELETE ERROR:",
                        deleteError
                    );

                }


                return res.status(400).json({

                    success:
                        false,

                    error:
                        pageError.message ||
                        "Unable to detect document pages."

                });

            }


            /* ==================================================
               DEFAULT PRINT SETTINGS
               ================================================== */

            const defaultColour =
                "Black & White";


            const defaultSides =
                "Single Side";


            const defaultCopies =
                1;


            const defaultRate =
                getPrintRate(
                    defaultColour,
                    defaultSides
                );


            const defaultAmount =
                calculatePrintAmount(
                    detectedPages,
                    defaultCopies,
                    defaultColour,
                    defaultSides
                );


            const defaultSheets =
                calculateSheets(
                    detectedPages,
                    defaultSides
                );


            /* ==================================================
               CREATE JOB
               ================================================== */

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
                    defaultColour,

                sides:
                    defaultSides,

                /*
                 * IMPORTANT:
                 *
                 * This is the REAL detected
                 * PDF page count.
                 */

                pages:
                    detectedPages,

                copies:
                    defaultCopies,

                sheets:
                    defaultSheets,

                rate:
                    defaultRate,

                amount:
                    defaultAmount,

                paymentStatus:
                    "PENDING",

                createdAt:
                    Date.now(),

                sessionToken:
                    token

            };


            /* ==================================================
               EVENT
               ================================================== */

            addEvent({

                type:
                    "document_received",

                job:
                    currentJob

            });


            console.log(
                "========================================"
            );

            console.log(
                "DOCUMENT RECEIVED"
            );

            console.log(
                "FILE:",
                currentJob.filename
            );

            console.log(
                "MIME:",
                currentJob.mimetype
            );

            console.log(
                "PAGES DETECTED:",
                currentJob.pages
            );

            console.log(
                "DEFAULT COPIES:",
                currentJob.copies
            );

            console.log(
                "========================================"
            );


            /* ==================================================
               RESPONSE
               ================================================== */

            res.status(200).json({

                success:
                    true,

                message:
                    "Document uploaded and page count detected successfully.",

                job:
                    currentJob

            });

        }

        catch (error) {

            console.error(
                "UPLOAD ERROR:",
                error
            );


            res.status(500).json({

                success:
                    false,

                error:
                    error.message ||
                    "Document upload failed."

            });

        }

    }
);


/* ============================================================
   CURRENT JOB
   ============================================================ */

app.get(
    "/api/current-job",
    function(req, res) {

        res.json({

            success:
                true,

            job:
                currentJob

        });

    }
);


/* ============================================================
   JOB
   ============================================================ */

app.get(
    "/api/job",
    function(req, res) {

        res.json({

            success:
                true,

            job:
                currentJob

        });

    }
);


/* ============================================================
   EVENTS
   ============================================================ */

app.get(
    "/api/events",
    function(req, res) {

        try {

            const since =
                Number(
                    req.query.since ||
                    0
                );


            const result =
                events.filter(
                    function(event) {

                        return (
                            event.id >
                            since
                        );

                    }
                );


            res.json(
                result
            );

        }

        catch (error) {

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


/* ============================================================
   SAVE PRINT OPTIONS
   ============================================================ */

app.post(
    "/api/options",
    function(req, res) {

        try {

            if (!currentJob) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        "No document has been received yet."

                });

            }


            /* ==================================================
               COLOUR
               ================================================== */

            const colour =
                req.body.colour ||
                req.body.color ||
                currentJob.colour ||
                "Black & White";


            /* ==================================================
               SIDES
               ================================================== */

            const sides =
                req.body.sides ||
                currentJob.sides ||
                "Single Side";


            /* ==================================================
               PAGES
               ==================================================

               IMPORTANT:

               The server already detected the REAL
               number of PDF pages during upload.

               Therefore we DO NOT trust a fake
               page number from the browser.

            */

            const pages =
                currentJob.pages;


            /* ==================================================
               COPIES
               ================================================== */

            let copies =
                Number(
                    req.body.copies ||
                    1
                );


            if (
                !Number.isFinite(copies) ||
                copies < 1
            ) {

                copies = 1;

            }


            copies =
                Math.floor(
                    copies
                );


            if (
                copies > 50
            ) {

                copies = 50;

            }


            /* ==================================================
               RATE
               ================================================== */

            const rate =
                getPrintRate(
                    colour,
                    sides
                );


            /* ==================================================
               AMOUNT
               ================================================== */

            const amount =
                calculatePrintAmount(
                    pages,
                    copies,
                    colour,
                    sides
                );


            /* ==================================================
               SHEETS
               ================================================== */

            const sheets =
                calculateSheets(
                    pages,
                    sides
                );


            /* ==================================================
               SAVE JOB
               ================================================== */

            currentJob.colour =
                colour;


            currentJob.sides =
                sides;


            currentJob.pages =
                pages;


            currentJob.copies =
                copies;


            currentJob.sheets =
                sheets;


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
                "========================================"
            );

            console.log(
                "PRINT OPTIONS"
            );

            console.log(
                "COLOUR:",
                colour
            );

            console.log(
                "SIDES:",
                sides
            );

            console.log(
                "PAGES:",
                pages
            );

            console.log(
                "SHEETS:",
                sheets
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

            console.log(
                "========================================"
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
                    rate,

                pages:
                    pages,

                copies:
                    copies,

                sheets:
                    sheets

            });

        }

        catch (error) {

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


/* ============================================================
   CREATE RAZORPAY ORDER
   ============================================================ */

app.post(
    "/api/create-order",
    async function(req, res) {

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
                        "AXM_" +
                        Date.now(),

                    notes: {

                        project:
                            "AXM Print Service",

                        job_id:
                            currentJob.id,

                        filename:
                            currentJob.filename,

                        pages:
                            String(
                                currentJob.pages
                            ),

                        copies:
                            String(
                                currentJob.copies
                            ),

                        sheets:
                            String(
                                currentJob.sheets
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

        }

        catch (error) {

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


/* ============================================================
   VERIFY RAZORPAY PAYMENT
   ============================================================ */

app.post(
    "/api/verify-payment",
    function(req, res) {

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


            /*
             * Avoid timingSafeEqual error
             * if lengths are different.
             */

            const expectedBuffer =
                Buffer.from(
                    expectedSignature,
                    "utf8"
                );


            const receivedBuffer =
                Buffer.from(
                    razorpay_signature,
                    "utf8"
                );


            if (
                expectedBuffer.length !==
                receivedBuffer.length
            ) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        "Payment verification failed."

                });

            }


            const valid =
                crypto.timingSafeEqual(
                    expectedBuffer,
                    receivedBuffer
                );


            if (!valid) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        "Payment verification failed."

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

        }

        catch (error) {

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


/* ============================================================
   TEST PAYMENT
   ============================================================ */

app.post(
    "/api/test-payment",
    function(req, res) {

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

                copies:
                    currentJob.copies,

                pages:
                    currentJob.pages,

                sheets:
                    currentJob.sheets,

                job:
                    currentJob

            });

        }

        catch (error) {

            console.error(
                "TEST PAYMENT ERROR:",
                error
            );


            res.status(500).json({

                success:
                    false,

                error:
                    "Test payment failed."

            });

        }

    }
);


/* ============================================================
   PRINT
   ============================================================ */

app.post(
    "/api/print",
    function(req, res) {

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


            /* ==================================================
               PRINT JOB
               ================================================== */

            const printJob = {

                jobId:
                    currentJob.id,

                filename:
                    currentJob.filename,

                filepath:
                    currentJob.filepath,

                colour:
                    currentJob.colour,

                sides:
                    currentJob.sides,

                pages:
                    currentJob.pages,

                sheets:
                    currentJob.sheets,

                /*
                 * VERY IMPORTANT:
                 *
                 * This is the number of copies
                 * selected by the user.
                 */

                copies:
                    currentJob.copies,

                amount:
                    currentJob.amount,

                paymentStatus:
                    currentJob.paymentStatus

            };


            currentJob.status =
                "PRINTING";


            currentJob.printJob =
                printJob;


            addEvent({

                type:
                    "printing",

                job:
                    currentJob

            });


            console.log(
                "========================================"
            );

            console.log(
                "PRINT JOB STARTED"
            );

            console.log(
                "FILE:",
                currentJob.filename
            );

            console.log(
                "COLOUR:",
                currentJob.colour
            );

            console.log(
                "SIDES:",
                currentJob.sides
            );

            console.log(
                "PAGES:",
                currentJob.pages
            );

            console.log(
                "SHEETS:",
                currentJob.sheets
            );

            console.log(
                "COPIES:",
                currentJob.copies
            );

            console.log(
                "AMOUNT:",
                currentJob.amount
            );

            console.log(
                "FILE PATH:",
                currentJob.filepath
            );

            console.log(
                "========================================"
            );


            /*
             * NOTE:
             *
             * This endpoint prepares the print job.
             *
             * Your physical printer must receive:
             *
             * filepath
             * pages
             * copies
             * colour
             * sides
             *
             * The copies value is NOT ignored.
             */


            res.json({

                success:
                    true,

                message:
                    "Print job is ready.",

                job:
                    currentJob,

                printUrl:
                    "/print.html",

                printJob:
                    printJob

            });

        }

        catch (error) {

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


/* ============================================================
   RESET
   ============================================================ */

app.post(
    "/api/reset",
    function(req, res) {

        /*
         * Delete previous uploaded file.
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

            }

            catch (error) {

                console.error(
                    "OLD FILE DELETE ERROR:",
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
                "AXM machine reset."

        });

    }
);


/* ============================================================
   ERROR HANDLER
   ============================================================ */

app.use(
    function(error, req, res, next) {

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


/* ============================================================
   API 404
   ============================================================ */

app.use(
    "/api",
    function(req, res) {

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


/* ============================================================
   START SERVER
   ============================================================ */

app.listen(
    PORT,
    "0.0.0.0",
    function() {

        console.log(
            "=========================================="
        );

        console.log(
            "AXM SERVER IS RUNNING"
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
            "PDF PAGE DETECTION: ENABLED"
        );

        console.log(
            "=========================================="

        );

    }
);
