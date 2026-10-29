/* Device verification page script. Served from the instance origin (CSP: script-src 'self'). */
(function () {
  "use strict";
  var input = document.getElementById("user_code");
  if (!input) return;
  input.addEventListener("input", function () {
    var raw = input.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    input.value = raw.length > 4 ? raw.slice(0, 4) + "-" + raw.slice(4) : raw;
  });
  var forms = document.querySelectorAll("form.code-form, form.decision-form");
  for (var i = 0; i < forms.length; i++) {
    forms[i].addEventListener("submit", function () {
      var field = this.querySelector('input[name="user_code"]');
      if (field) field.value = field.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    });
  }
  input.focus();
})();
