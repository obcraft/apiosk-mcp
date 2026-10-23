// Self-contained so the card can use the same account-currency formatter.
export function approvalFeedback(data, money, fallback) {
  const error = data?.errors?.find(error => typeof error?.message === 'string');
  const message = data?.message || error?.message || fallback;
  const details = error?.details;
  if (!details || details.currency !== 'USD') return message;
  const required = money(details.required_atomic, 'USD', true);
  const available = money(details.available_atomic, 'USD');
  if (required == null || available == null) return message;
  const end = ' Nothing was purchased by this approval attempt.';
  switch (error.code) {
    case 'approval_per_request_limit':
      return 'This request needs up to ' + required + ', but your connection allows ' + available + ' per request. Set higher limits below, or ask a smaller question.' + end;
    case 'approval_daily_limit':
      return 'This request needs up to ' + required + ', but your connection has ' + available + ' left in its daily budget. Set a higher daily limit below, try later, or ask a smaller question.' + end;
    case 'approval_balance_insufficient':
      return 'This request needs up to ' + required + ', but your available Apiosk balance is ' + available + '. Add funds in Apiosk > Balance, or ask a smaller question.' + end;
    default:
      return message;
  }
}
