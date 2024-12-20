require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors());
app.use(express.json({limit: '50mb'}));
app.use(express.urlencoded({limit: '50mb', extended: true}));

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY?.trim(),
});
console.log('API Key available:', !!process.env.ANTHROPIC_API_KEY);

const { parse } = require('pg-connection-string');

const connectionString = process.env.DATABASE_URL || 'postgresql://postgres@localhost:5432/contact_manager';
const config = parse(connectionString);
const pool = new Pool({
    ...config,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});
const storage = multer.diskStorage({
    destination: './uploads/',
    filename: function(req, file, cb) {
        if (!file.mimetype.startsWith('image/') && !file.mimetype.startsWith('audio/')) {
            cb(new Error('Only image and audio files are allowed'));
            return;
        }
        cb(null, 'upload-' + Date.now() + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    fileFilter: (req, file, cb) => {
        if (!file.mimetype.startsWith('image/') && !file.mimetype.startsWith('audio/')) {
            cb(null, false);
            return;
        }
        cb(null, true);
    },
    limits: { fileSize: 50 * 1024 * 1024 }
});

if (!fs.existsSync('./uploads')) {
    fs.mkdirSync('./uploads');
}

app.get('/', async (req, res) => {
    try {
        const result = await pool.query('SELECT NOW()');
        res.json({ 
            message: "Contact Manager API is running!",
            dbConnected: true,
            serverTime: result.rows[0].now
        });
    } catch (err) {
        res.status(500).json({ 
            message: "Contact Manager API is running!",
            dbConnected: false,
            error: err.message
        });
    }
});

app.post('/api/voice-input', async (req, res) => {
    try {
        const { text } = req.body;
        if (!text) {
            return res.status(400).json({ error: 'No text provided' });
        }

        const message = await anthropic.messages.create({
            model: "claude-3-haiku-20240307",
            max_tokens: 1024,
            messages: [{
                role: "user",
                content: `Extract contact information from this text and respond ONLY with a JSON object (no other text) with these exact fields: full_name, title, company, email, phone, website, additional_details. If any field is missing, use an empty string. Here's the text: "${text}"`
            }]
        });

        try {
            // Try to parse the response as JSON
            const extractedData = JSON.parse(message.content[0].text);
            res.json(extractedData);
        } catch (parseError) {
            console.log('Claude response:', message.content[0].text);
            // If parsing fails, return a structured error response
            res.status(422).json({
                error: 'Failed to parse response',
                rawResponse: message.content[0].text,
                formattedData: {
                    full_name: "",
                    title: "",
                    company: "",
                    email: "",
                    phone: "",
                    website: "",
                    additional_details: "Failed to process voice input"
                }
            });
        }
    } catch (error) {
        console.error('Voice processing error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/voice', (req, res) => {
    res.sendFile(__dirname + '/voice-input.html');
});

app.post('/api/scan-card', upload.single('card'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No image uploaded' });
        }

        const imageBuffer = fs.readFileSync(req.file.path);
        const base64Image = imageBuffer.toString('base64');
        
        console.log('Image size:', imageBuffer.length, 'bytes');
        console.log('File type:', req.file.mimetype);

        const message = await anthropic.messages.create({
            model: "claude-3-haiku-20240307",
            max_tokens: 1024,
            messages: [{
                role: "user",
                content: [
                    {
                        type: "text",
                        text: "This is a business card or LinkedIn profile image. Please extract the following information in JSON format with these exact fields: full_name, title, company, email, phone, website, address, additional_phones (as array), social_media (as object), and other_details. If any field is not found, use an empty string or empty array/object as appropriate."
                    },
                    {
                        type: "image",
                        source: {
                            type: "base64",
                            media_type: req.file.mimetype,
                            data: base64Image
                        }
                    }
                ]
            }]
        });

        let extractedData;
        try {
            extractedData = JSON.parse(message.content[0].text);
            console.log('Raw Extracted Data:', extractedData);
            
            const formattedData = {
                contact: {
                    first_name: extractedData.full_name.split(' ')[0] || "",
                    last_name: extractedData.full_name.split(' ').slice(1).join(' ') || "",
                    title: extractedData.title || "",
                    company: extractedData.company || "",
                    email: extractedData.email || "",
                    phone: extractedData.phone || "",
                    website: extractedData.website || ""
                },
                additional_info: {
                    address: extractedData.address || "",
                    additional_phones: extractedData.additional_phones || [],
                    social_media: extractedData.social_media || {},
                    other_details: extractedData.other_details || ""
                },
                quality: {
                    missing_fields: Object.entries(extractedData)
                        .filter(([_, value]) => !value || (Array.isArray(value) && !value.length) || (typeof value === 'object' && !Object.keys(value).length))
                        .map(([key, _]) => key),
                    completeness: Object.values(extractedData)
                        .filter(value => value && !(Array.isArray(value) && !value.length) && !(typeof value === 'object' && !Object.keys(value).length))
                        .length / Object.keys(extractedData).length * 100
                }
            };

            res.json(formattedData);

        } catch (error) {
            console.error('Error parsing Claude response:', message.content[0].text);
            res.status(422).json({
                error: 'Failed to parse extracted data',
                details: message.content[0].text
            });
        }

        fs.unlink(req.file.path, (err) => {
            if (err) console.error('Error deleting file:', err);
        });

    } catch (error) {
        console.error('Full error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/scan-card', upload.single('card'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No image uploaded' });
        }

        const imageBuffer = fs.readFileSync(req.file.path);
        const base64Image = imageBuffer.toString('base64');
        
        // Get extracted data from Claude
        const message = await anthropic.messages.create({
            model: "claude-3-haiku-20240307",
            max_tokens: 1024,
            messages: [{
                role: "user",
                content: [
                    {
                        type: "text",
                        text: "Extract contact information from this image in JSON format with these fields: full_name, title, company, email, phone, website"
                    },
                    {
                        type: "image",
                        source: {
                            type: "base64",
                            media_type: req.file.mimetype,
                            data: base64Image
                        }
                    }
                ]
            }]
        });

        // Parse the extracted data
        const extractedData = JSON.parse(message.content[0].text);

        // Save to database
        const nameParts = extractedData.full_name.split(' ');
        const firstName = nameParts[0];
        const lastName = nameParts.slice(1).join(' ');

        const result = await pool.query(
            `INSERT INTO contacts (first_name, last_name, title, company, email, phone, website) 
             VALUES ($1, $2, $3, $4, $5, $6, $7) 
             RETURNING *`,
            [firstName, lastName, extractedData.title, extractedData.company, 
             extractedData.email, extractedData.phone, extractedData.website]
        );

        // Return both extracted and saved data
        res.json({
            extracted: extractedData,
            saved: result.rows[0],
            message: 'Contact saved successfully'
        });

        // Clean up uploaded file
        fs.unlink(req.file.path, (err) => {
            if (err) console.error('Error deleting file:', err);
        });

    } catch (error) {
        console.error('Full error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/contacts', async (req, res) => {
    try {
        const { first_name, last_name, company, title, email, phone } = req.body;
        const result = await pool.query(
            'INSERT INTO contacts (first_name, last_name, company, title, email, phone) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [first_name, last_name, company, title, email, phone]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get all contacts with search functionality
// Get all contacts with search functionality
app.get('/api/contacts', async (req, res) => {
    try {
        const { search } = req.query;
        let query = 'SELECT * FROM contacts';
        
        let result;
        if (search) {
            query += ` WHERE 
                first_name ILIKE $1 OR 
                last_name ILIKE $1 OR 
                company ILIKE $1 OR 
                email ILIKE $1`;
            result = await pool.query(query, [`%${search}%`]);
        } else {
            result = await pool.query(query + ' ORDER BY created_at DESC');
        }

        console.log('Contacts query result:', result.rows); // Debug log
        res.json({ contacts: result.rows }); // Wrap in an object
    } catch (err) {
        console.error('Database error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Get single contact with their interactions
app.get('/api/contacts/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const contact = await pool.query('SELECT * FROM contacts WHERE id = $1', [id]);
        const interactions = await pool.query(
            'SELECT * FROM interactions WHERE contact_id = $1 ORDER BY date DESC',
            [id]
        );
        
        if (contact.rows.length === 0) {
            return res.status(404).json({ error: 'Contact not found' });
        }
        
        res.json({
            ...contact.rows[0],
            interactions: interactions.rows
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update contact
app.put('/api/contacts/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { first_name, last_name, company, title, email, phone } = req.body;
        
        const result = await pool.query(
            `UPDATE contacts 
            SET first_name = $1, last_name = $2, company = $3, 
                title = $4, email = $5, phone = $6, 
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $7 
            RETURNING *`,
            [first_name, last_name, company, title, email, phone, id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Contact not found' });
        }
        
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete contact
app.delete('/api/contacts/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // First delete related interactions
        await pool.query('DELETE FROM interactions WHERE contact_id = $1', [id]);
        
        // Then delete the contact
        const result = await pool.query(
            'DELETE FROM contacts WHERE id = $1 RETURNING *',
            [id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Contact not found' });
        }
        
        res.json({ message: 'Contact deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/contacts/:id/details', async (req, res) => {
    try {
        const contact = await pool.query('SELECT * FROM contacts WHERE id = $1', [req.params.id]);
        const interactions = await pool.query(
            'SELECT * FROM interactions WHERE contact_id = $1 ORDER BY date DESC',
            [req.params.id]
        );
        const tasks = await pool.query(
            'SELECT * FROM tasks WHERE contact_id = $1 ORDER BY due_date ASC',
            [req.params.id]
        );

        res.json({
            contact: contact.rows[0],
            interactions: interactions.rows,
            tasks: tasks.rows
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/dashboard', (req, res) => {
    res.sendFile(__dirname + '/contacts-dashboard.html');
});

app.get('/dashboard', (req, res) => {
    res.sendFile(__dirname + '/dashboard.html');
});

app.get('/scan', (req, res) => {
    res.sendFile(__dirname + '/card-scanner.html');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});