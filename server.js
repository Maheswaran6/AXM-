const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const Razorpay = require("razorpay");

const app = express();

const PORT = process.env.PORT || 10000;
const HOST = "0.0.0.0";

// =====================================================
// UPLOAD FOLDER
// =====================================================

const UPLOADS = path.join(__dirname, "uploads");

if (!fs.existsSync(UPLOADS)) {
    fs.mkdirSync(UPLOADS, { recursive: true });
}

// =====================================================
// MIDDLEWARE
// =====================================================

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(__dirname));

// =====================================================
// MULTER UPLOAD CONFIGURATION
// =====================================================

const storage = multer.diskStorage({

    destination: function (req, file, cb) {
        cb(null, UPLOADS);
    },

    filename: function (req, file, cb) {

        const extension =
            path.extname(file.originalname).toLowerCase();

        const safeName =
            crypto.randomBytes(16).toString("hex") +
            extension;

        cb(null, safeName);
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


// =====================================================
// AXM MACHINE JOB
// =====================================================

let currentJob = null;

let nextJobId = 1;


// =====================================================
// MACHINE EVENTS
// =====================================================

let events = [];

let nextEventId = 1;


function emit(type, data) {

    const event = {

        id: nextEventId++,

        type: type,

        time: Date.now(),

        ...data

    };


    events.push(event);


    // Keep only latest 100 events

    if (events.length > 100) {

        events =
            events.slice(-100);

    }


    console.log(
        "EVENT:",
        type
    );

}


// =====================================================
// HOME
// =====================================================

app.get("/", (req, res) => {

    res.sendFile(
        path.join(
            __dirname,
            "index.html"
        )
    );

});


// =====================================================
// RAZORPAY CONFIGURATION
// =====================================================

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

} else {

    console.log(
        "Razorpay: NOT CONFIGURED"
    );

}


// =====================================================
// PAYMENT CONFIG
// =====================================================

app.get(
    "/api/payment-config",
    (req, res) => {

        res.json({

            configured:
                !!razorpay,

            key_id:
                RAZORPAY_KEY_ID || null

        });

    }
);


// =====================================================
// CREATE RAZORPAY ORDER
// =====================================================

app.post(
    "/api/create-order",
    async (req, res) => {

        try {

            if (!razorpay) {

                return res.status(500).json({

                    success: false,

                    message:
                        "Razorpay is not configured on the server."

                });

            }


            const amount =
                Number(req.body.amount);


            if (
                !Number.isFinite(amount) ||
                amount <= 0
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Invalid payment amount."

                });

            }


            const amountInPaise =
                Math.round(
                    amount * 100
                );


            const options = {

                amount:
                    amountInPaise,

                currency:
                    "INR",

                receipt:
                    `AXM_${Date.now()}`,

                notes: {

                    project:
                        "AXM Print Service"

                }

            };


            const order =
                await razorpay.orders.create(
                    options
                );


            console.log(
                "Razorpay order:",
                order.id
            );


            res.json({

                success: true,

                order:
                    order

            });


        } catch (error) {

            console.error(
                "Create order error:",
                error
            );


            res.status(500).json({

                success: false,

                message:
                    error.error?.description ||
                    error.message ||
                    "Unable to create payment order."

            });

        }

    }
);


// =====================================================
// VERIFY RAZORPAY PAYMENT
// =====================================================

app.post(
    "/api/verify-payment",
    (req, res) => {

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

                    success: false,

                    message:
                        "Missing payment verification details."

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
                expectedSignature ===
                razorpay_signature;


            if (!valid) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Payment verification failed."

                });

            }


            console.log(
                "Payment verified:",
                razorpay_payment_id
            );


            res.json({

                success: true,

                message:
                    "Payment verified successfully.",

                payment_id:
                    razorpay_payment_id,

                order_id:
                    razorpay_order_id

            });


        } catch (error) {

            console.error(
                "Payment verification error:",
                error
            );


            res.status(500).json({

                success: false,

                message:
                    "Payment verification failed."

            });

        }

    }
);


// =====================================================
// TEST PAYMENT
// =====================================================

app.post(
    "/api/test-payment",
    (req, res) => {

        const amount =
            Number(req.body.amount);


        if (
            !Number.isFinite(amount) ||
            amount <= 0
        ) {

            return res.status(400).json({

                success: false,

                message:
                    "Invalid amount."

            });

        }


        res.json({

            success: true,

            message:
                "Test payment successful.",

            amount:
                amount

        });

    }
);


// =====================================================
// UPLOAD DOCUMENT FROM PHONE
// =====================================================

app.post(
    "/api/upload",
    upload.single("document"),
    (req, res) => {

        try {

            console.log(
                "======================================"
            );

            console.log(
                "PHONE UPLOAD RECEIVED"
            );


            // -----------------------------------------
            // CHECK FILE
            // -----------------------------------------

            if (!req.file) {

                console.log(
                    "No file received."
                );


                return res.status(400).json({

                    ok: false,

                    error:
                        "No document was received."

                });

            }


            console.log(
                "Filename:",
                req.file.originalname
            );


            console.log(
                "Size:",
                req.file.size
            );


            console.log(
                "Type:",
                req.file.mimetype
            );


            // -----------------------------------------
            // REMOVE PREVIOUS JOB FILE
            // -----------------------------------------

            if (
                currentJob &&
                currentJob.storedFile
            ) {

                const oldFile =
                    path.join(
                        UPLOADS,
                        currentJob.storedFile
                    );


                if (
                    fs.existsSync(oldFile)
                ) {

                    try {

                        fs.unlinkSync(
                            oldFile
                        );

                    } catch (error) {

                        console.log(
                            "Could not remove old file."
                        );

                    }

                }

            }


            // -----------------------------------------
            // CREATE NEW JOB
            // -----------------------------------------

            currentJob = {

                id:
                    String(nextJobId++),

                filename:
                    req.file.originalname,

                storedFile:
                    req.file.filename,

                mimetype:
                    req.file.mimetype,

                size:
                    req.file.size,

                status:
                    "received",

                createdAt:
                    Date.now()

            };


            // -----------------------------------------
            // NOTIFY AXM MACHINE
            // -----------------------------------------

            emit(
                "job_received",
                {

                    job:
                        currentJob

                }
            );


            console.log(
                "JOB CREATED:",
                currentJob.id
            );


            console.log(
                "Document successfully sent to AXM."
            );


            console.log(
                "======================================"
            );


            // -----------------------------------------
            // SEND JSON RESPONSE TO PHONE
            // -----------------------------------------

            return res.status(200).json({

                ok: true,

                message:
                    "Document sent successfully to AXM.",

                job:
                    currentJob

            });


        } catch (error) {

            console.error(
                "UPLOAD ERROR:",
                error
            );


            return res.status(500).json({

                ok: false,

                error:
                    error.message ||
                    "Upload failed."

            });

        }

    }
);


// =====================================================
// MACHINE EVENTS
// =====================================================

app.get(
    "/api/events",
    (req, res) => {

        const since =
            Number(req.query.since) || 0;


        const newEvents =
            events.filter(
                event =>
                    event.id > since
            );


        res.json(
            newEvents
        );

    }
);


// =====================================================
// GET CURRENT JOB
// =====================================================

app.get(
    "/api/current-job",
    (req, res) => {

        res.json({

            job:
                currentJob

        });

    }
);


// =====================================================
// MACHINE STATUS
// =====================================================

app.get(
    "/api/machine-status",
    (req, res) => {

        res.json({

            online:
                true,

            job:
                currentJob,

            time:
                Date.now()

        });

    }
);


// =====================================================
// DOWNLOAD DOCUMENT
// =====================================================

app.get(
    "/api/download/:jobId",
    (req, res) => {

        if (
            !currentJob ||
            currentJob.id !==
                req.params.jobId
        ) {

            return res
                .status(404)
                .send(
                    "File not found"
                );

        }


        const filePath =
            path.join(
                UPLOADS,
                currentJob.storedFile
            );


        if (
            !fs.existsSync(filePath)
        ) {

            return res
                .status(404)
                .send(
                    "Document file not found"
                );

        }


        res.download(

            filePath,

            currentJob.filename

        );

    }
);


// =====================================================
// PRINT JOB
// =====================================================

app.post(
    "/api/print",
    (req, res) => {

        try {

            if (!currentJob) {

                return res.status(404).json({

                    ok: false,

                    error:
                        "No document available."

                });

            }


            currentJob.status =
                "printing";


            emit(
                "printing_started",
                {

                    job:
                        currentJob

                }
            );


            /*
             * Temporary print simulation.
             *
             * Real Windows printer connection
             * will be added later.
             */

            setTimeout(
                () => {

                    if (
                        currentJob
                    ) {

                        currentJob.status =
                            "printed";


                        emit(
                            "printing_completed",
                            {

                                job:
                                    currentJob

                            }
                        );

                    }

                },
                2500
            );


            res.json({

                ok: true,

                job:
                    currentJob

            });


        } catch (error) {

            console.error(
                "Print error:",
                error
            );


            res.status(500).json({

                ok: false,

                error:
                    error.message ||
                    "Print failed."

            });

        }

    }
);


// =====================================================
// ERROR HANDLER
// =====================================================

app.use(
    (err, req, res, next) => {

        console.error(
            "SERVER ERROR:",
            err
        );


        let message =
            err.message ||
            "Request failed";


        if (
            err instanceof multer.MulterError
        ) {

            if (
                err.code ===
                "LIMIT_FILE_SIZE"
            ) {

                message =
                    "File is too large. Maximum size is 25 MB.";

            }

        }


        res.status(400).json({

            ok: false,

            error:
                message

        });

    }
);


// =====================================================
// SERVER START
// =====================================================

app.listen(
    PORT,
    HOST,
    () => {

        console.log(
            "=========================================="
        );

        console.log(
            " AXM V2.2 SERVER IS RUNNING"
        );

        console.log(
            ` Port: ${PORT}`
        );

        console.log(
            ` Computer: http://localhost:${PORT}`
        );

        console.log(
            ` Razorpay: ${
                razorpay
                    ? "CONFIGURED"
                    : "NOT CONFIGURED"
            }`
        );

        console.log(
            " Upload API: READY"
        );

        console.log(
            " Machine Events: READY"
        );

        console.log(
            "=========================================="
        );

    }
);
