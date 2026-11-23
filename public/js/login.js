// -----------------------------
// Login
// -----------------------------
$("#login-form").on("submit", async function (e) {
  e.preventDefault();

  const userName = $("#input-username").val();
  const password = $("#input-password").val();

  const $btn = $("#btn-login");
  const $error = $("#add-error");

  if (!userName) return $error.text("Uporabniško ime je obvezno!").removeClass("hidden");
  if (!password) return $error.text("Geslo je obvezno!").removeClass("hidden");

  $btn.prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin mr-2"></i> Prijavljam...');
  $error.addClass("hidden");

  try {
    await $.ajax({
      url: "/api/login",
      method: "POST",
      contentType: "application/json",
      data: JSON.stringify({ userName, password }),
    });

    //window.location.href = "/home"
    window.location.href = "/"
  } catch (err) {
    console.error(err);

    // Show server error message nicely if available
    const msg =
      err?.responseJSON?.error ||
      err?.responseText ||
      err?.statusText ||
      "Registracija ni uspela.";

    $error.text(msg).removeClass("hidden");
  } finally {
    $btn.prop("disabled", false).html('<i class="fa-solid fa-user-plus mr-2"></i> Prijava');
  }
});
