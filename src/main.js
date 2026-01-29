import './style.css';
import { initAuth } from './modules/auth.js';
import { initCalendar } from './modules/calendar.js';
import { initSecurity } from './modules/security.js';

document.addEventListener('DOMContentLoaded', () => {
  // Force unregister legacy service workers
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(function (registrations) {
      for (let registration of registrations) {
        registration.unregister();
        console.log("Legacy Service Worker unregistered.");
      }
    });
  }

  initSecurity(); // Initialize security first to lock screen if needed
  initAuth();
  initCalendar();
});
