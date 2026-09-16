import { Redirect } from "expo-router";

/**
 * Browser builds cannot receive or claim native Share extension receipts.
 * Keep this platform route free of every native custody owner even though the
 * root capability authority also rejects direct `/share` navigation.
 */
export default function ShareDestinationWebUnavailable() {
  return <Redirect href="/" />;
}
