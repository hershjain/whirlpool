/* whirlpool — login.
 *
 * Two steps on one page: phone number, then the six-digit code. No navigation
 * between them, so the back button never lands someone halfway through.
 *
 * The server answers /auth/request-code with the same 204 no matter what
 * happened — unknown number, opted out, rate limited, bad number — so this
 * file cannot report any of those, and deliberately does not try. Everything
 * it needs to say is said up front instead. */

const phoneStep = document.getElementById("phone-step");
const codeStep = document.getElementById("code-step");
const phoneInput = document.getElementById("phone");
const codeInput = document.getElementById("code");
const phoneSubmit = document.getElementById("phone-submit");
const codeSubmit = document.getElementById("code-submit");
const resendBtn = document.getElementById("resend");
const changeNumberBtn = document.getElementById("change-number");
const errorEl = document.getElementById("error");

// The landing page's join steps. Same origin as this page now, so it is a
// plain relative link that works in every environment without configuration.
document.getElementById("join-link").href = "/#join";

const RESEND_SECONDS = 60;

let phone = "";
let resendTimer = null;

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function clearError() {
  errorEl.hidden = true;
  errorEl.textContent = "";
}

async function postJson(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // The session cookie is same-origin, but being explicit keeps this honest
    // if the page is ever served from somewhere else.
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
}

/* ------------------------------------------------------------ resend timer */

// A visible countdown, because the server enforces one code per minute per
// number and silently drops the rest. Without the timer people tap resend
// four times, get nothing extra, and conclude the product is broken.
function startResendCountdown() {
  let remaining = RESEND_SECONDS;
  resendBtn.disabled = true;

  const tick = () => {
    resendBtn.textContent = remaining > 0 ? `resend code (${remaining}s)` : "resend code";
    if (remaining === 0) {
      resendBtn.disabled = false;
      clearInterval(resendTimer);
      resendTimer = null;
      return;
    }
    remaining -= 1;
  };

  tick();
  clearInterval(resendTimer);
  resendTimer = setInterval(tick, 1000);
}

/* -------------------------------------------------------------- step one */

async function requestCode() {
  clearError();
  phoneSubmit.disabled = true;

  try {
    await postJson("/auth/request-code", { phone });
  } catch {
    // A network failure is the one thing worth reporting here: it is about
    // this browser, not about whether the number is known.
    showError("Couldn't reach Whirlpool. Check your connection and try again.");
    phoneSubmit.disabled = false;
    return false;
  }

  phoneSubmit.disabled = false;
  return true;
}

phoneStep.addEventListener("submit", async (e) => {
  e.preventDefault();

  const value = phoneInput.value.trim();
  if (!value) {
    showError("Enter the phone number you text Whirlpool from.");
    return;
  }
  phone = value;

  if (!(await requestCode())) return;

  phoneStep.hidden = true;
  codeStep.hidden = false;
  startResendCountdown();
  codeInput.focus();
});

/* -------------------------------------------------------------- step two */

codeStep.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearError();

  const code = codeInput.value.trim();
  if (!/^\d{6}$/.test(code)) {
    showError("Enter the six digits from the message.");
    return;
  }

  codeSubmit.disabled = true;

  let res;
  try {
    res = await postJson("/auth/verify", { phone, code });
  } catch {
    showError("Couldn't reach Whirlpool. Check your connection and try again.");
    codeSubmit.disabled = false;
    return;
  }

  if (res.status === 204) {
    // Replace, not assign: the login page should not sit in history behind
    // the canvas, where Back would land on a form that no longer applies.
    window.location.replace("/app");
    return;
  }

  const body = await res.json().catch(() => ({}));
  showError(body.error || "That didn't work. Request a new code and try again.");
  codeSubmit.disabled = false;
  codeInput.select();
});

resendBtn.addEventListener("click", async () => {
  if (await requestCode()) startResendCountdown();
});

changeNumberBtn.addEventListener("click", () => {
  clearError();
  clearInterval(resendTimer);
  resendTimer = null;
  codeInput.value = "";
  codeStep.hidden = true;
  phoneStep.hidden = false;
  phoneInput.focus();
  phoneInput.select();
});

// Strip anything that is not a digit as it is typed, so a pasted "123-456"
// or a code copied with surrounding text still submits cleanly.
codeInput.addEventListener("input", () => {
  const digits = codeInput.value.replace(/\D/g, "").slice(0, 6);
  if (digits !== codeInput.value) codeInput.value = digits;
  // Six digits in is unambiguous: submit rather than making them find the
  // button, which is what the autofill flow expects to happen.
  if (digits.length === 6) codeStep.requestSubmit();
});

// --- DEV-LOGIN: local development only, remove before launch ---
//
// Ask first, show second. The button appears only when /auth/dev-login says the
// bypass exists, so in production this block finds `enabled: false` and renders
// nothing - and if the routes are removed and this is not, the fetch 404s and it
// still renders nothing.
(async () => {
  const wrap = document.getElementById("dev-login-wrap");
  const button = document.getElementById("dev-login");
  if (!wrap || !button) return;

  try {
    const res = await fetch("/auth/dev-login", { credentials: "same-origin" });
    if (!res.ok) return;
    const { enabled } = await res.json();
    if (!enabled) return;
  } catch {
    return;
  }

  wrap.hidden = false;

  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const res = await fetch("/auth/dev-login", {
        method: "POST",
        credentials: "same-origin",
      });
      if (res.status === 204) {
        window.location.replace("/app");
        return;
      }
      showError("Dev login failed. Check the server log.");
    } catch {
      showError("Dev login failed. Check the server log.");
    }
    button.disabled = false;
  });
})();
