const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const Attendance = require('../models/Attendance');
const User = require('../models/User');

// Helper to get protocol and host cleanly (supporting HTTPS behind Vercel/proxies)
function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  return `${proto}://${req.get('host')}`;
}

// Fallback user avatar SVG (served when an attendance image is missing or cannot be loaded)
const FALLBACK_AVATAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="10" fill="#e2e8f0"/>
  <circle cx="50" cy="40" r="20" fill="#94a3b8"/>
  <path d="M20 85 C20 68 35 65 50 65 C65 65 80 68 80 85 Z" fill="#94a3b8"/>
</svg>`;

// Helper to ensure public/uploads directory exists (safe for Vercel read-only FS)
const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');
try {
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
} catch (e) {
  // Ignored on read-only environments like Vercel
}

// 1. Submit Attendance API (POST)
router.post('/submit', async (req, res) => {
  try {
    const { empId, password, status, location, selfie } = req.body;

    if (!empId || !location || !selfie) {
      return res.status(400).json({ success: false, message: 'Employee ID, selfie, and location are required.' });
    }

    const trimmedId = empId.trim();

    // Check in User collection by empId or email
    const user = await User.findOne({
      $or: [
        { empId: trimmedId },
        { empId: trimmedId.toUpperCase() },
        { email: trimmedId.toLowerCase() }
      ]
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Employee ID not found! Please check your ID or sign up first.'
      });
    }

    // If password is provided, verify it with bcrypt
    if (password && user.password) {
      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        return res.status(401).json({
          success: false,
          message: 'Incorrect password! Please enter the correct password.'
        });
      }
    }

    // Save base64 image as actual JPEG file in public/uploads/ (if disk is writable)
    let imageRelativePath = '';
    if (selfie && selfie.startsWith('data:image')) {
      try {
        const filename = `selfie-${user.empId}-${Date.now()}.jpg`;
        const filePath = path.join(uploadsDir, filename);
        const base64Data = selfie.replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(filePath, base64Data, 'base64');
        imageRelativePath = `/uploads/${filename}`;
      } catch (err) {
        // Read-only filesystem fallback on Vercel: store in DB directly
        imageRelativePath = '';
      }
    }

    const record = new Attendance({
      empId: user.empId,
      empName: user.name,
      status: status || 'Present',
      location,
      selfie: selfie, // Always preserve the actual image data in DB (works on Vercel)
      imageUrl: imageRelativePath || ''
    });

    await record.save();

    const fullImageUrl = `/api/attendance/image/${record._id}`;

    res.status(201).json({
      success: true,
      message: `Attendance recorded successfully for ${user.name}!`,
      empName: user.name,
      imageUrl: fullImageUrl,
      data: record
    });
  } catch (error) {
    console.error('Error saving attendance:', error);
    res.status(500).json({ success: false, message: 'Server error saving attendance.' });
  }
});

// 2. Serve Image by Attendance ID (GET /api/attendance/image/:id)
// Returns real binary JPEG image or clean fallback SVG avatar
router.get('/image/:id', async (req, res) => {
  try {
    const record = await Attendance.findById(req.params.id);
    if (!record) {
      res.set('Content-Type', 'image/svg+xml');
      return res.send(FALLBACK_AVATAR_SVG);
    }

    const imgRef = record.selfie || record.imageUrl;
    if (!imgRef) {
      res.set('Content-Type', 'image/svg+xml');
      return res.send(FALLBACK_AVATAR_SVG);
    }

    // If it's a file saved on disk in public/uploads and exists
    if (typeof imgRef === 'string' && (imgRef.startsWith('/uploads/') || imgRef.startsWith('uploads/'))) {
      const filePath = path.join(__dirname, '..', 'public', imgRef.replace(/^\//, ''));
      if (fs.existsSync(filePath)) {
        return res.sendFile(filePath);
      }
      // If missing from disk (e.g. serverless Vercel deploy), serve fallback SVG
      res.set('Content-Type', 'image/svg+xml');
      return res.send(FALLBACK_AVATAR_SVG);
    }

    // If it's an external URL
    if (typeof imgRef === 'string' && (imgRef.startsWith('http://') || imgRef.startsWith('https://'))) {
      return res.redirect(imgRef);
    }

    // If it's Base64 string in database
    if (typeof imgRef === 'string') {
      const matches = imgRef.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
      if (matches && matches.length === 3) {
        const mimeType = matches[1];
        const buffer = Buffer.from(matches[2], 'base64');
        res.set('Content-Type', mimeType);
        res.set('Cache-Control', 'public, max-age=86400');
        return res.send(buffer);
      } else if (imgRef.length > 50 && !imgRef.startsWith('/')) {
        const cleanBase64 = imgRef.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(cleanBase64, 'base64');
        res.set('Content-Type', 'image/jpeg');
        res.set('Cache-Control', 'public, max-age=86400');
        return res.send(buffer);
      }
    }

    // Fallback if format is not recognized
    res.set('Content-Type', 'image/svg+xml');
    return res.send(FALLBACK_AVATAR_SVG);
  } catch (err) {
    console.error('Error serving image:', err);
    res.set('Content-Type', 'image/svg+xml');
    res.send(FALLBACK_AVATAR_SVG);
  }
});

// 3. Fetch All Attendance & Login Logs API (GET /api/attendance/logs or /api/attendance/all)
router.get(['/all', '/logs'], async (req, res) => {
  try {
    const { empId, date, limit } = req.query;
    const filter = {};

    if (empId) {
      const trimmed = empId.trim();
      filter.$or = [
        { empId: trimmed },
        { empId: trimmed.toUpperCase() }
      ];
    }

    if (date) {
      const searchDate = new Date(date);
      const startOfDay = new Date(searchDate.setHours(0, 0, 0, 0));
      const endOfDay = new Date(searchDate.setHours(23, 59, 59, 999));
      filter.createdAt = { $gte: startOfDay, $lte: endOfDay };
    }

    let query = Attendance.find(filter).sort({ createdAt: -1 });
    if (limit && !isNaN(parseInt(limit))) {
      query = query.limit(parseInt(limit));
    }

    const records = await query.exec();

    // Fetch user emails to attach to records
    const users = await User.find().select('empId email name');
    const userMap = {};
    users.forEach(u => {
      userMap[u.empId] = u;
    });

    const detailedLogs = records.map(r => {
      const createdAt = new Date(r.createdAt || Date.now());
      const u = userMap[r.empId] || {};
      const lat = r.location?.lat;
      const lng = r.location?.lng;

      // Clean image URL: using relative path avoids mixed content (http vs https)
      const hasImg = !!(r.selfie || r.imageUrl);
      const imgUrl = hasImg ? `/api/attendance/image/${r._id}` : '';

      return {
        recordId: r._id,
        empId: r.empId,
        empName: r.empName || u.name || 'Employee',
        email: u.email || 'N/A',
        status: r.status || 'Present',
        punchDate: createdAt.toLocaleDateString(),
        punchTime: createdAt.toLocaleTimeString(),
        timestamp: createdAt.toISOString(),
        location: {
          address: r.location?.address || 'N/A',
          lat: lat,
          lng: lng,
          accuracy: r.location?.accuracy,
          googleMapsUrl: (lat && lng) ? `https://www.google.com/maps?q=${lat},${lng}` : null
        },
        imageUrl: imgUrl, // Direct clickable image URL
        selfie: imgUrl,   // Clean URL for frontend table
        createdAt: r.createdAt
      };
    });

    res.status(200).json({
      success: true,
      totalRecords: detailedLogs.length,
      data: detailedLogs
    });
  } catch (error) {
    console.error('Error fetching records:', error);
    res.status(500).json({ success: false, message: 'Server error fetching records.', error: error.message });
  }
});

// 4. Fetch All Employees Full Summary (GET /api/attendance/employees)
router.get('/employees', async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ createdAt: -1 });
    const attendances = await Attendance.find().sort({ createdAt: -1 });

    const attendanceMap = {};
    attendances.forEach((att) => {
      const id = (att.empId || '').trim();
      if (!attendanceMap[id]) attendanceMap[id] = [];

      const cleanAtt = att.toObject();
      const hasImg = !!(att.selfie || att.imageUrl);
      cleanAtt.imageUrl = hasImg ? `/api/attendance/image/${att._id}` : '';
      cleanAtt.selfie = cleanAtt.imageUrl;

      attendanceMap[id].push(cleanAtt);
    });

    const fullEmployeeData = [];
    const processedEmpIds = new Set();

    for (const u of users) {
      const empId = u.empId;
      processedEmpIds.add(empId);
      const userAttendances = attendanceMap[empId] || [];
      fullEmployeeData.push({
        empId: u.empId,
        name: u.name,
        email: u.email,
        registeredAt: u.createdAt,
        totalAttendance: userAttendances.length,
        latestAttendance: userAttendances[0] || null,
        attendanceHistory: userAttendances
      });
    }

    for (const [empId, records] of Object.entries(attendanceMap)) {
      if (!processedEmpIds.has(empId)) {
        fullEmployeeData.push({
          empId: empId,
          name: records[0]?.empName || 'Employee',
          email: 'N/A',
          registeredAt: null,
          totalAttendance: records.length,
          latestAttendance: records[0] || null,
          attendanceHistory: records
        });
      }
    }

    res.status(200).json({
      success: true,
      totalEmployees: fullEmployeeData.length,
      data: fullEmployeeData
    });
  } catch (err) {
    console.error('Error fetching employee summary:', err);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
});

module.exports = router;