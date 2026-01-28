import './style.css';
import { initAuth } from './modules/auth.js';
import { initCalendar } from './modules/calendar.js';
import { initSecurity } from './modules/security.js';

document.addEventListener('DOMContentLoaded', () => {
  initSecurity(); // Initialize security first to lock screen if needed
  initAuth();
  initCalendar();
});
