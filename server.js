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

// MongoDB Connection (Serverless-compatible connection cache)
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://arvindkumar2224JK:Arvind2020@cluster0.ekvk4yc.mongodb.net/?appName=Cluster0';

let cachedConnection = null;
async function connectToDatabase() {
  if (cachedConnection && mongoose.connection.readyState === 1) {
    return cachedConnection;
  }
  try {
    const opts = {
      bufferCommands: false,
      serverSelectionTimeoutMS: 5000,
    };
    cachedConnection = await mongoose.connect(MONGO_URI, opts);
    console.log('MongoDB Connected Successfully');
    return cachedConnection;
  } catch (err) {
    console.error('MongoDB Connection Error:', err.message);
  }
}

// Connect immediately and before handling API requests
connectToDatabase();

app.use(async (req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    await connectToDatabase();
  }
  next();
});

// Routes Mounting
app.use('/api/auth', authRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/employees', employeeRoutes);

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