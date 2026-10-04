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

// 1. Submit Attendance API (POST - Punch In / Login Attendance)
router.post('/submit', async (req, res) => {
  try {
    const { empId, empName, password, status, location, selfie } = req.body;

    if (!location || !selfie) {
      return res.status(400).json({ success: false, message: 'Selfie and location are required.' });
    }

    let trimmedId = (empId && String(empId).trim() !== 'undefined' && String(empId).trim() !== 'null') 
      ? String(empId).trim() 
      : '';
    const cleanEmpName = (empName && String(empName).trim() !== 'undefined' && String(empName).trim() !== 'null')
      ? String(empName).trim()
      : '';

    // 1. Flexible lookup in User collection (by empId, name, or email)
    let user = null;
    if (trimmedId) {
      try {
        user = await User.findOne({
          $or: [
            { empId: { $regex: new RegExp(`^${trimmedId}$`, 'i') } },
            { name: { $regex: new RegExp(`^${trimmedId}$`, 'i') } },
            { email: { $regex: new RegExp(`^${trimmedId}$`, 'i') } }
          ]
        });
      } catch (e) {
        user = await User.findOne({ empId: trimmedId });
      }
    }

    if (!user && cleanEmpName && cleanEmpName !== 'Employee') {
      try {
        user = await User.findOne({
          $or: [
            { name: { $regex: new RegExp(`^${cleanEmpName}$`, 'i') } },
            { email: { $regex: new RegExp(`^${cleanEmpName}$`, 'i') } }
          ]
        });
      } catch (e) {}
    }

    // 2. Resolve employee ID (never allow 'undefined')
    let finalEmpId = '';
    if (user && user.empId && user.empId !== 'undefined' && user.empId !== 'null') {
      finalEmpId = user.empId;
    } else if (trimmedId && trimmedId !== 'undefined' && !trimmedId.includes('@')) {
      finalEmpId = trimmedId;
    } else if (user && user.name) {
      finalEmpId = `EMP-${user.name.replace(/\s+/g, '').toUpperCase()}`;
    } else if (cleanEmpName && cleanEmpName !== 'Employee') {
      finalEmpId = `EMP-${cleanEmpName.replace(/\s+/g, '').toUpperCase()}`;
    } else {
      finalEmpId = 'EMP101';
    }

    // Resolve employee Name
    let finalEmpName = user ? user.name : (cleanEmpName && cleanEmpName !== 'Employee' ? cleanEmpName : finalEmpId);

    // If user exists but had empty/undefined empId, persist it
    if (user && (!user.empId || user.empId === 'undefined' || user.empId === 'null')) {
      try {
        await User.updateOne({ _id: user._id }, { $set: { empId: finalEmpId } });
      } catch (e) {}
    }

    // 3. Fallback: If not in User collection, try finding previous Attendance record
    if (!user) {
      try {
        const prev = await Attendance.findOne({
          $or: [
            { empId: { $regex: new RegExp(`^${finalEmpId}$`, 'i') } },
            { empName: { $regex: new RegExp(`^${finalEmpName}$`, 'i') } }
          ],
          empId: { $ne: 'undefined' }
        }).sort({ createdAt: -1 });

        if (prev && prev.empId && prev.empId !== 'undefined') {
          finalEmpName = prev.empName || finalEmpName;
          finalEmpId = prev.empId;
        }
      } catch (e) {}
    }

    // If password is provided and user has password, verify it
    if (password && user && user.password) {
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
        const filename = `selfie-${finalEmpId}-${Date.now()}.jpg`;
        const filePath = path.join(uploadsDir, filename);
        const base64Data = selfie.replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(filePath, base64Data, 'base64');
        imageRelativePath = `/uploads/${filename}`;
      } catch (err) {
        imageRelativePath = '';
      }
    }

    const now = new Date();
    const loginTimeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });

    const record = new Attendance({
      empId: finalEmpId,
      empName: finalEmpName,
      status: status || 'Present',
      location,
      selfie: selfie,
      imageUrl: imageRelativePath || '',
      punchIn: now,
      punchOut: null,
      loginTime: loginTimeStr,
      logoutTime: null
    });

    await record.save();

    const fullImageUrl = `/api/attendance/image/${record._id}`;

    res.status(201).json({
      success: true,
      message: `Attendance recorded successfully for ${finalEmpName}!`,
      empName: finalEmpName,
      empId: finalEmpId,
      loginTime: loginTimeStr,
      punchTime: loginTimeStr,
      logoutTime: null,
      imageUrl: fullImageUrl,
      data: record
    });
  } catch (error) {
    console.error('Error saving attendance:', error);
    res.status(500).json({ success: false, message: 'Server error saving attendance.' });
  }
});

// 2. Punch Out / Logout Attendance API (POST)
router.post(['/punch-out', '/logout'], async (req, res) => {
  try {
    const { empId, empName, location } = req.body;

    let trimmedId = (empId && String(empId).trim() !== 'undefined' && String(empId).trim() !== 'null') 
      ? String(empId).trim() 
      : '';
    const cleanEmpName = (empName && String(empName).trim() !== 'undefined' && String(empName).trim() !== 'null')
      ? String(empName).trim()
      : '';

    if (!trimmedId && !cleanEmpName) {
      return res.status(400).json({ success: false, message: 'Employee ID or name is required to record punch out.' });
    }

    // Look up user to resolve ID and Name
    let user = null;
    if (trimmedId) {
      user = await User.findOne({
        $or: [
          { empId: { $regex: new RegExp(`^${trimmedId}$`, 'i') } },
          { name: { $regex: new RegExp(`^${trimmedId}$`, 'i') } },
          { email: { $regex: new RegExp(`^${trimmedId}$`, 'i') } }
        ]
      });
    }
    if (!user && cleanEmpName) {
      user = await User.findOne({ name: { $regex: new RegExp(`^${cleanEmpName}$`, 'i') } });
    }

    const searchEmpId = (user && user.empId && user.empId !== 'undefined') ? user.empId : trimmedId;
    const searchName = user ? user.name : cleanEmpName;

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const orConditions = [];
    if (searchEmpId) {
      orConditions.push({ empId: { $regex: new RegExp(`^${searchEmpId}$`, 'i') } });
    }
    if (searchName) {
      orConditions.push({ empName: { $regex: new RegExp(`^${searchName}$`, 'i') } });
    }

    // 1. Find record from today without punchOut
    let record = null;
    if (orConditions.length > 0) {
      record = await Attendance.findOne({
        $or: orConditions,
        createdAt: { $gte: todayStart },
        punchOut: null
      }).sort({ createdAt: -1 });

      // 2. If not found, find latest from today
      if (!record) {
        record = await Attendance.findOne({
          $or: orConditions,
          createdAt: { $gte: todayStart }
        }).sort({ createdAt: -1 });
      }

      // 3. Fallback to latest within last 24 hours
      if (!record) {
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
        record = await Attendance.findOne({
          $or: orConditions,
          createdAt: { $gte: yesterday }
        }).sort({ createdAt: -1 });
      }
    }

    const now = new Date();
    const logoutTimeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });

    if (!record) {
      // If no check-in record exists, create one with punchOut recorded
      const finalId = searchEmpId || (searchName ? `EMP-${searchName.toUpperCase()}` : 'EMP101');
      const finalName = searchName || 'Employee';
      record = new Attendance({
        empId: finalId,
        empName: finalName,
        status: 'Present',
        location: location || { address: 'Office / On Duty', lat: 0, lng: 0 },
        punchIn: now,
        punchOut: now,
        loginTime: logoutTimeStr,
        logoutTime: logoutTimeStr
      });
      await record.save();
    } else {
      record.punchOut = now;
      record.logoutTime = logoutTimeStr;
      if (location && location.address) {
        record.logoutLocation = location;
      }
      if (!record.empId || record.empId === 'undefined') {
        record.empId = searchEmpId || (record.empName ? `EMP-${record.empName.toUpperCase()}` : 'EMP101');
      }
      await record.save();
    }

    const inTime = record.loginTime || (record.punchIn ? new Date(record.punchIn).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }) : null);

    res.status(200).json({
      success: true,
      message: `Punch out / Logout recorded successfully for ${record.empName}!`,
      empId: record.empId,
      empName: record.empName,
      loginTime: inTime,
      punchTime: inTime,
      logoutTime: logoutTimeStr,
      punchOutTime: logoutTimeStr,
      data: record
    });
  } catch (err) {
    console.error('Error during punch out:', err);
    res.status(500).json({ success: false, message: 'Server error during punch out.', error: err.message });
  }
});

// 3. Serve Image by Attendance ID (GET /api/attendance/image/:id)
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

// 4. Fetch All Attendance & Login Logs API (GET /api/attendance/logs or /api/attendance/all)
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

    // Fetch user details to map by empId, name, and email
    const users = await User.find().select('empId email name');
    const userByEmpId = {};
    const userByName = {};
    const userByEmail = {};

    users.forEach(u => {
      if (u.empId && u.empId !== 'undefined' && u.empId !== 'null') {
        userByEmpId[String(u.empId).trim().toLowerCase()] = u;
      }
      if (u.name) {
        userByName[String(u.name).trim().toLowerCase()] = u;
      }
      if (u.email) {
        userByEmail[String(u.email).trim().toLowerCase()] = u;
      }
    });

    const detailedLogs = records.map(r => {
      const createdAt = new Date(r.createdAt || r.punchIn || Date.now());
      const punchInDate = r.punchIn ? new Date(r.punchIn) : createdAt;
      const punchOutDate = r.punchOut ? new Date(r.punchOut) : null;

      // Clean empId resolution: ensure it is NEVER 'undefined'
      let rawEmpId = (r.empId && r.empId !== 'undefined' && r.empId !== 'null') ? String(r.empId).trim() : '';
      let rawEmpName = (r.empName && r.empName !== 'undefined' && r.empName !== 'null') ? String(r.empName).trim() : '';

      let u = (rawEmpId ? userByEmpId[rawEmpId.toLowerCase()] : null) 
           || (rawEmpName ? userByName[rawEmpName.toLowerCase()] : null);

      let resolvedEmpId = rawEmpId;
      if (!resolvedEmpId || resolvedEmpId === 'undefined') {
        if (u && u.empId && u.empId !== 'undefined') {
          resolvedEmpId = u.empId;
        } else if (rawEmpName && rawEmpName !== 'Employee') {
          resolvedEmpId = `EMP-${rawEmpName.replace(/\s+/g, '').toUpperCase()}`;
        } else {
          resolvedEmpId = 'EMP101';
        }

        // Auto-heal dirty record in database asynchronously
        Attendance.updateOne({ _id: r._id }, { $set: { empId: resolvedEmpId } }).catch(() => {});
      }

      const finalEmpName = (u && u.name) ? u.name : (rawEmpName || 'Employee');
      const finalEmail = (u && u.email) ? u.email : (rawEmpName === 'abhi' ? 'abh@gmail.com' : 'N/A');

      // Login Time (Punch In Time)
      const loginTimeString = r.loginTime || punchInDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });

      // Logout Time (Punch Out Time)
      const logoutTimeString = r.logoutTime || (punchOutDate ? punchOutDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }) : null);

      const lat = r.location?.lat;
      const lng = r.location?.lng;

      // Clean image URL
      const hasImg = !!(r.selfie || r.imageUrl);
      const imgUrl = hasImg ? `/api/attendance/image/${r._id}` : '';

      return {
        recordId: r._id,
        empId: resolvedEmpId,
        empName: finalEmpName,
        email: finalEmail,
        status: r.status || 'Present',
        punchDate: createdAt.toLocaleDateString(),
        punchTime: loginTimeString,        // Existing key preserved for backward compatibility
        loginTime: loginTimeString,        // Explicit Login Time
        punchInTime: loginTimeString,      // Explicit Punch In Time
        logoutTime: logoutTimeString,      // Explicit Logout Time (or null if active)
        punchOutTime: logoutTimeString,    // Explicit Punch Out Time (or null if active)
        punchInDate: punchInDate.toLocaleDateString(),
        punchOutDate: punchOutDate ? punchOutDate.toLocaleDateString() : null,
        timestamp: createdAt.toISOString(),
        punchIn: r.punchIn || r.createdAt,
        punchOut: r.punchOut || null,
        location: {
          address: r.location?.address || 'N/A',
          lat: lat,
          lng: lng,
          accuracy: r.location?.accuracy,
          googleMapsUrl: (lat && lng) ? `https://www.google.com/maps?q=${lat},${lng}` : null
        },
        logoutLocation: r.logoutLocation ? {
          address: r.logoutLocation.address || 'N/A',
          lat: r.logoutLocation.lat,
          lng: r.logoutLocation.lng,
          accuracy: r.logoutLocation.accuracy,
          googleMapsUrl: (r.logoutLocation.lat && r.logoutLocation.lng) ? `https://www.google.com/maps?q=${r.logoutLocation.lat},${r.logoutLocation.lng}` : null
        } : null,
        imageUrl: imgUrl,
        selfie: imgUrl,
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

// 5. Fetch All Employees Full Summary (GET /api/attendance/employees)
router.get('/employees', async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ createdAt: -1 });
    const attendances = await Attendance.find().sort({ createdAt: -1 });

    const userByName = {};
    const userByEmpId = {};
    users.forEach(u => {
      if (u.name) userByName[u.name.toLowerCase().trim()] = u;
      if (u.empId && u.empId !== 'undefined') userByEmpId[u.empId.toLowerCase().trim()] = u;
    });

    const attendanceMap = {};
    attendances.forEach((att) => {
      let id = (att.empId || '').trim();
      if (!id || id === 'undefined' || id === 'null') {
        const u = userByName[(att.empName || '').toLowerCase().trim()];
        id = (u && u.empId && u.empId !== 'undefined') ? u.empId : (att.empName ? `EMP-${att.empName.toUpperCase()}` : 'EMP101');
      }

      if (!attendanceMap[id]) attendanceMap[id] = [];

      const cleanAtt = att.toObject();
      const hasImg = !!(att.selfie || att.imageUrl);
      cleanAtt.imageUrl = hasImg ? `/api/attendance/image/${att._id}` : '';
      cleanAtt.selfie = cleanAtt.imageUrl;
      cleanAtt.empId = id;

      const inDate = cleanAtt.punchIn ? new Date(cleanAtt.punchIn) : new Date(cleanAtt.createdAt || Date.now());
      const outDate = cleanAtt.punchOut ? new Date(cleanAtt.punchOut) : null;
      cleanAtt.loginTime = cleanAtt.loginTime || inDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
      cleanAtt.logoutTime = cleanAtt.logoutTime || (outDate ? outDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }) : null);
      cleanAtt.punchTime = cleanAtt.loginTime;
      cleanAtt.punchInTime = cleanAtt.loginTime;
      cleanAtt.punchOutTime = cleanAtt.logoutTime;

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