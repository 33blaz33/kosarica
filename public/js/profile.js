// -----------------------------
// Profile
// -----------------------------
async function loadProfile() {
  const $error = $("#add-error");
  const $success = $("#add-success");
  $error.addClass("hidden");
  $success.addClass("hidden");

  try {
    const me = await $.ajax({ url: "/api/profile", method: "GET" });

    $("#input-username").val(me.userName || "");
    $("#input-firstname").val(me.firstName || "");
    $("#input-lastname").val(me.lastName || "");
    $("#input-email").val(me.email || "");
    $("#input-active-email").prop("checked", !!me.activeEmail);
  } catch (err) {
    const msg =
      err?.responseJSON?.error ||
      err?.responseText ||
      err?.statusText ||
      "Napaka pri nalaganju profila.";
    $error.text(msg).removeClass("hidden");
  }
}

$(async function () {
  await loadProfile();
});

$("#profile-form").on("submit", async function (e) {
  e.preventDefault();

  const firstName = $("#input-firstname").val().trim();
  const lastName = $("#input-lastname").val().trim();
  const email = $("#input-email").val().trim();
  const password = $("#input-password").val(); // opcijsko
  const activeEmail = $("#input-active-email").prop("checked");

  const $btn = $("#btn-save");
  const $error = $("#add-error");
  const $success = $("#add-success");

  $error.addClass("hidden");
  $success.addClass("hidden");

  if (!firstName) return $error.text("Ime je obvezno!").removeClass("hidden");
  if (!lastName) return $error.text("Priimek je obvezen!").removeClass("hidden");

  // zelo osnovna validacija emaila (če je vpisan)
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return $error.text("E-mail ni veljaven.").removeClass("hidden");
  }

  /*if (password && password.length < 6) {
    return $error.text("Novo geslo naj ima vsaj 6 znakov.").removeClass("hidden");
  }*/

  $btn.prop("disabled", true).text("Shranjujem...");

  try {
    await $.ajax({
      url: "/api/profile",
      method: "PUT",
      contentType: "application/json",
      data: JSON.stringify({ firstName, lastName, email, password, activeEmail }),
    });

    $("#input-password").val(""); // počisti polje za geslo
    $success.text("Profil je shranjen.").removeClass("hidden");
  } catch (err) {
    const msg =
      err?.responseJSON?.error ||
      err?.responseText ||
      err?.statusText ||
      "Shranjevanje ni uspelo.";
    $error.text(msg).removeClass("hidden");
  } finally {
    $btn.prop("disabled", false).text("Shrani");
  }
});

$("#btn-back").on("click", async function (e) {
  window.history.back();
});
