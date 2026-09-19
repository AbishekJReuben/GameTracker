package __PACKAGE__;

import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

public final class DecoderInboxTest {
  private static void check(boolean value, String message) {
    if (!value) throw new AssertionError(message);
  }
  private static DecoderInbox.Frame frame(long sequence, boolean key, long at) {
    return new DecoderInbox.Frame(sequence, key, new byte[20], 4, 16, at);
  }
  public static void main(String[] args) throws Exception {
    DecoderInbox q = new DecoderInbox();
    check(!q.offer(frame(1, false, 0), 0), "fresh decoder rejects P before IDR");
    check(q.offer(frame(2, true, 0), 0), "IDR opens reference chain");
    check(q.offer(frame(3, false, 0), 0), "P may wait behind CSD/IDR during startup");
    check(q.offer(frame(4, false, 0), 0), "third frame");
    check(q.peek(0).tsUs == 2, "FIFO IDR cannot be overtaken by a newer P");
    check(q.remove(q.peek(0)), "consume IDR");
    check(q.peek(0).tsUs == 3, "P chain stays ordered");
    for (int i = 5; i <= 8; i++) check(q.offer(frame(i, false, 0), 0), "absorb a short burst");
    check(!q.offer(frame(9, false, 0), 0), "overflow rejects entire dependent chain");
    check(q.size() == 0 && q.needsKey(), "overflow must gate to IDR");
    check(!q.offer(frame(7, false, 0), 0), "cannot continue from a discarded reference");
    check(q.offer(frame(8, true, 0), 0), "IDR recovers");
    check(q.peek(151) == null && q.needsKey(), "stale frames expire even without a new arrival");
    check(q.offer(frame(9, true, 200), 200), "recover after expiry");
    check(!q.offer(new DecoderInbox.Frame(10, false, new byte[1], 1, 1, 200), 200), "bad bounds rejected");
    check(q.needsKey(), "invalid unit breaks chain");
    byte[] large = new byte[9_000_000];
    check(q.offer(new DecoderInbox.Frame(11, true, large, 0, large.length, 0), 0), "large IDR");
    check(!q.offer(new DecoderInbox.Frame(12, false, large, 0, large.length, 0), 0), "byte budget independent of frame count");
    check(q.offer(frame(13, true, 0), 0), "recover byte overflow");
    q.clear();

    AtomicBoolean done = new AtomicBoolean(false);
    AtomicReference<Throwable> failure = new AtomicReference<>();
    Thread producer = new Thread(() -> {
      try {
        for (int i = 0; i < 100_000; i++) {
          q.offer(frame(i, i % 7 == 0, 0), 0);
          check(q.size() <= DecoderInbox.MAX_FRAMES, "bounded under bursts");
          if (i % 11 == 0) Thread.yield();
        }
      } catch (Throwable e) { failure.set(e); }
      finally { done.set(true); }
    });
    Thread consumer = new Thread(() -> {
      try {
        long last = -1;
        while (!done.get() || q.size() > 0) {
          DecoderInbox.Frame f = q.peek(0);
          if (f != null && q.remove(f)) {
            check(f.tsUs > last, "never repeat or reorder");
            check(f.key || f.tsUs == last + 1, "never decode a P with a missing reference");
            last = f.tsUs;
          } else Thread.yield();
        }
      } catch (Throwable e) { failure.set(e); }
    });
    producer.start(); consumer.start(); producer.join(); consumer.join();
    if (failure.get() != null) throw new AssertionError(failure.get());
    System.out.println("DecoderInbox: FIFO, IDR recovery, time/byte bounds and 100,000 concurrent inputs passed");
  }
}
