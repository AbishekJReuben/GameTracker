package __PACKAGE__;

/** Pure transition policy, shared by the Android callback and JVM regression test.
 * Signal/bandwidth capability updates must not reconnect a healthy Notes socket. */
final class ClipboardNetworkState {
  private Object network;
  private boolean validated;
  private boolean observed;

  boolean update(Object next, boolean isValidated, boolean socketMissing) {
    boolean transition = !java.util.Objects.equals(network, next) || !validated;
    boolean reconnect = isValidated && transition && (observed || socketMissing);
    network = next;
    validated = isValidated;
    observed = true;
    return reconnect;
  }

  void lost(Object lost) {
    if (java.util.Objects.equals(network, lost)) validated = false;
  }
}
