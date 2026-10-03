const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const Attendance = require('../models/Attendance');
const User = require('../models/User');

// Helper to ensure public/uploads directory exists
const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
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

    // Save base64 image as actual JPEG file in public/uploads/
    let imageRelativePath = '';
    if (selfie && selfie.startsWith('data:image')) {
      const filename = `selfie-${user.empId}-${Date.now()}.jpg`;
      const filePath = path.join(uploadsDir, filename);
      const base64Data = selfie.replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(filePath, base64Data, 'base64');
      imageRelativePath = `/uploads/${filename}`;
    }

    const record = new Attendance({
      empId: user.empId,
      empName: user.name,
      status: status || 'Present',
      location,
      selfie: imageRelativePath || selfie,
      imageUrl: imageRelativePath
    });

    await record.save();

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const fullImageUrl = imageRelativePath 
      ? `${baseUrl}${imageRelativePath}` 
      : `${baseUrl}/api/attendance/image/${record._id}`;

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
// Returns real binary JPEG image so you can open/view it directly via URL
router.get('/image/:id', async (req, res) => {
  try {
    const record = await Attendance.findById(req.params.id);
    if (!record || (!record.selfie && !record.imageUrl)) {
      return res.status(404).send('Image not found');
    }

    const imgRef = record.imageUrl || record.selfie;

    // If it's a file saved on disk in public/uploads
    if (imgRef.startsWith('/uploads/') || imgRef.startsWith('uploads/')) {
      const filePath = path.join(__dirname, '..', 'public', imgRef.replace(/^\//, ''));
      if (fs.existsSync(filePath)) {
        return res.sendFile(filePath);
      }
    }

    // If it's an external URL
    if (imgRef.startsWith('http://') || imgRef.startsWith('https://')) {
      return res.redirect(imgRef);
    }

    // If it's Base64 string in database
    const matches = imgRef.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (matches && matches.length === 3) {
      const mimeType = matches[1];
      const buffer = Buffer.from(matches[2], 'base64');
      res.set('Content-Type', mimeType);
      return res.send(buffer);
    } else {
      const buffer = Buffer.from(imgRef.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      res.set('Content-Type', 'image/jpeg');
      return res.send(buffer);
    }
  } catch (err) {
    console.error('Error serving image:', err);
    res.status(500).send('Error serving image');
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

    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const detailedLogs = records.map(r => {
      const createdAt = new Date(r.createdAt || Date.now());
      const u = userMap[r.empId] || {};
      const lat = r.location?.lat;
      const lng = r.location?.lng;

      // Clean image URL instead of giant base64 string
      const imgUrl = (r.imageUrl && r.imageUrl.startsWith('/uploads/'))
        ? `${baseUrl}${r.imageUrl}`
        : `${baseUrl}/api/attendance/image/${r._id}`;

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

    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const attendanceMap = {};
    attendances.forEach((att) => {
      const id = (att.empId || '').trim();
      if (!attendanceMap[id]) attendanceMap[id] = [];

      const cleanAtt = att.toObject();
      cleanAtt.imageUrl = (att.imageUrl && att.imageUrl.startsWith('/uploads/'))
        ? `${baseUrl}${att.imageUrl}`
        : `${baseUrl}/api/attendance/image/${att._id}`;
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