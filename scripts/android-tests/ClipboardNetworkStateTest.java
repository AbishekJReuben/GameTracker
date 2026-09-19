package __PACKAGE__;

public final class ClipboardNetworkStateTest {
  private static void check(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }
  public static void main(String[] args) {
    ClipboardNetworkState state = new ClipboardNetworkState();
    check(!state.update("wifi", true, false), "initial callback retains existing socket");
    for (int i = 0; i < 10000; i++) {
      check(!state.update("wifi", true, false), "signal/bandwidth updates cannot reconnect");
    }
    check(state.update("mobile", true, false), "default-network switch reconnects once");
    check(!state.update("mobile", true, false), "same mobile network is stable");
    state.lost("wifi");
    check(!state.update("mobile", true, false), "loss of old WiFi cannot disturb mobile");
    state.lost("mobile");
    check(state.update("mobile", true, false), "restored network reconnects stale socket");
    check(!state.update("mobile", false, false), "invalid network does not cause retries");
    check(state.update("mobile", true, false), "new validation recovers connectivity");
    check(new ClipboardNetworkState().update("wifi", true, true), "missing socket connects immediately");
    System.out.println("ClipboardNetworkState: 10,000 repeated updates and recovery checks passed");
  }
}
