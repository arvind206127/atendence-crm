const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  empId: { type: String, unique: true, required: true },
  name: { type: String, required: true, trim: true },
  email: { type: String, unique: true, required: true, lowercase: true },
  password: { type: String, required: true },
  role: { type: String, default: 'EMPLOYEE' },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', userSchema);