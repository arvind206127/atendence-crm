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

// MongoDB Connection
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://arvindkumar2224JK:Arvind2020@cluster0.ekvk4yc.mongodb.net/?appName=Cluster0';
mongoose.connect(MONGO_URI)
    .then(() => console.log('MongoDB Connected Successfully'))
    .catch((err) => console.error('MongoDB Connection Error:', err));

// Routes Mounting
app.use('/api/auth', authRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/employees', employeeRoutes);

// Static files / Frontend serve karne ke liye
app.use(express.static(path.join(__dirname, 'public')));

// यहाँ '*' की जगह regex (/.*/l) का इस्तेमाल किया गया है ताकि एरर न आए
app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));