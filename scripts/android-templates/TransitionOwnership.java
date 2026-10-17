package __PACKAGE__;

/** Single-flight ownership includes a pending UI action and an outstanding
 * PixelCopy callback. A timeout invalidates work without pretending its native
 * destination bitmap has already been released. */
final class TransitionOwnership {
  private long serial;
  private long owner;
  synchronized long begin(){if(owner!=0)return 0;owner=++serial;return owner;}
  synchronized boolean current(long ticket){return ticket!=0&&ticket==owner&&ticket==serial;}
  synchronized void complete(long ticket){if(owner==ticket)owner=0;}
  synchronized void invalidate(){++serial;}
  synchronized void invalidate(long ticket){if(serial==ticket)++serial;}
}
