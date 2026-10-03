const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config();

const authRoutes = require('./routes/Auth');
const attendanceRoutes = require('./routes/attendance');
const employeeRoutes = require('./routes/employees');

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// MongoDB Connection (Serverless Caching Fix)
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://arvindkumar2224JK:Arvind2020@cluster0.ekvk4yc.mongodb.net/?appName=Cluster0';

let isConnected = false;

async function connectToDatabase() {
  if (isConnected && mongoose.connection.readyState === 1) {
    return;
  }

  try {
    const opts = {
      bufferCommands: true, // Vercel par connection ready hone tak query queue mein rahe gi
      serverSelectionTimeoutMS: 5000,
    };
    const db = await mongoose.connect(MONGO_URI, opts);
    isConnected = db.connections[0].readyState === 1;
    console.log('MongoDB Connected Successfully');
  } catch (err) {
    console.error('MongoDB Connection Error:', err.message);
    throw err;
  }
}

// Middleware: Ensure DB Connection Before Any Request Handles
app.use(async (req, res, next) => {
  try {
    await connectToDatabase();
    next();
  } catch (err) {
    res.status(500).json({ error: 'Database Connection Failed' });
  }
});

// Routes Mounting (supports both direct /api/... and serverless /... paths)
app.use('/api/auth', authRoutes);
app.use('/auth', authRoutes);

app.use('/api/attendance', attendanceRoutes);
app.use('/attendance', attendanceRoutes);

app.use('/api/employees', employeeRoutes);
app.use('/employees', employeeRoutes);

// Static files / Frontend serve karne ke liye
app.use(express.static(path.join(__dirname, 'public')));

// Fallback to index.html for SPA/frontend
app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start local server if not running inside Vercel serverless environment
const PORT = process.env.PORT || 5000;
if (!process.env.VERCEL) {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

// Crucial for Vercel Serverless Function export
module.exports = app;