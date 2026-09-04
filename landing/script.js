(function () {
  "use strict";

  var config = window.CRESAMOR_LANDING_CONFIG || {};

  // ---------- Footer year ----------
  var yearEl = document.getElementById("footer-year");
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  // ---------- Footer social links ----------
  // Renders a real link when a URL is configured, or a visibly disabled
  // (non-clickable) placeholder when it isn't -- never a fabricated URL.
  var footerSocial = document.getElementById("footer-social");
  if (footerSocial) {
    var links = config.SOCIAL_LINKS || {};
    var labels = { instagram: "Instagram", facebook: "Facebook" };
    Object.keys(labels).forEach(function (key) {
      var url = links[key];
      var el;
      if (url) {
        el = document.createElement("a");
        el.href = url;
        el.target = "_blank";
        el.rel = "noopener noreferrer";
      } else {
        el = document.createElement("span");
        el.className = "social-link-disabled";
      }
      el.textContent = labels[key];
      footerSocial.appendChild(el);
    });
  }

  // ---------- "Become an Early User" scroll ----------
  document.querySelectorAll("[data-scroll-to]").forEach(function (trigger) {
    trigger.addEventListener("click", function () {
      var targetId = trigger.getAttribute("data-scroll-to");
      var target = document.getElementById(targetId);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
        var firstField = target.querySelector("input, select, textarea");
        if (firstField) {
          // Delay focus slightly so it lands after the scroll animation
          // starts, not before -- avoids an abrupt input focus outline
          // jumping the page before scrollIntoView takes effect.
          window.setTimeout(function () {
            firstField.focus();
          }, 400);
        }
      }
    });
  });

  // ---------- Interest form submission ----------
  var form = document.getElementById("interest-form-el");
  var statusEl = document.getElementById("interest-form-status");
  var submitBtn = form ? form.querySelector(".interest-submit-btn") : null;

  function setStatus(message, state) {
    if (!statusEl) return;
    statusEl.textContent = message;
    if (state) statusEl.setAttribute("data-state", state);
    else statusEl.removeAttribute("data-state");
  }

  if (form) {
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      setStatus("", null);

      var formData = new FormData(form);
      var payload = {
        name: formData.get("name"),
        email: formData.get("email"),
        roleOrInterest: formData.get("roleOrInterest"),
        sport: formData.get("sport"),
        teamOrProgram: formData.get("teamOrProgram"),
        message: formData.get("message"),
        website: formData.get("website"), // honeypot -- always empty for a real visitor
      };

      if (!payload.name || !payload.email || !payload.roleOrInterest) {
        setStatus("Please fill in your name, email, and who you are.", "error");
        return;
      }

      if (submitBtn) submitBtn.disabled = true;
      setStatus("Sending…", null);

      var apiBase = config.API_BASE_URL || "";

      fetch(apiBase + "/api/interest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
        .then(function (response) {
          return response.json().then(function (data) {
            return { ok: response.ok, data: data };
          });
        })
        .then(function (result) {
          if (submitBtn) submitBtn.disabled = false;
          if (result.ok) {
            form.reset();
            setStatus("Thanks! We'll be in touch as we open up early access.", "success");
          } else {
            setStatus((result.data && result.data.error) || "Something went wrong. Please try again.", "error");
          }
        })
        .catch(function () {
          if (submitBtn) submitBtn.disabled = false;
          setStatus("Something went wrong. Please check your connection and try again.", "error");
        });
    });
  }
})();
