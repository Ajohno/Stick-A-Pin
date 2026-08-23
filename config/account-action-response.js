const GENERIC_ACCOUNT_ACTION_MESSAGE =
  "If the address can be used, check your email for the next step.";

function genericAccountActionResponse() {
  return { status: 202, body: { message: GENERIC_ACCOUNT_ACTION_MESSAGE } };
}

module.exports = { GENERIC_ACCOUNT_ACTION_MESSAGE, genericAccountActionResponse };
