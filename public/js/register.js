// -----------------------------
// Register
// -----------------------------
$("#register-form").on("submit", async function (e) {
  e.preventDefault();

  const userName = $("#input-username").val();
  const firstName = $("#input-firstname").val();
  const lastName = $("#input-lastname").val();
  const password = $("#input-password").val();

  const $btn = $("#btn-register");
  const $error = $("#add-error");

  if (!userName) return $error.text("Uporabniško ime je obvezno!").removeClass("hidden");
  if (!firstName) return $error.text("Polje ime je obvezno!").removeClass("hidden");
  if (!lastName) return $error.text("Polje priimek je obvezno!").removeClass("hidden");
  if (!password) return $error.text("Geslo je obvezno!").removeClass("hidden");

  $btn.prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin mr-2"></i> Registriram...');
  $error.addClass("hidden");

  try {
    await $.ajax({
      url: "/api/register",
      method: "POST",
      contentType: "application/json",
      data: JSON.stringify({ userName, firstName, lastName, password }),
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
    $btn.prop("disabled", false).html('<i class="fa-solid fa-user-plus mr-2"></i> Registracija');
  }
});
