// config.js — the one obvious place to edit landing-page-wide settings
// that aren't page copy: the app's API origin (for the interest form)
// and social links.
window.CRESAMOR_LANDING_CONFIG = {
  // The authenticated app's origin — same backend the interest form
  // submits to (a narrow, dedicated CORS policy for this one endpoint
  // lives in server/app.js; see that file's comments).
  API_BASE_URL: "https://app.cresamor.com",

  // Provided directly by the project owner (2026-09-04).
  SOCIAL_LINKS: {
    instagram: "https://www.instagram.com/cresamorsports",
    facebook: "https://www.facebook.com/share/1VjuXuz31D/?mibextid=wwXIfr",
  },
};
