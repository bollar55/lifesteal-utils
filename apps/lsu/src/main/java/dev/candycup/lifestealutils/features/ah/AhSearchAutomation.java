package dev.candycup.lifestealutils.features.ah;

public final class AhSearchAutomation {
   private static String pendingQuery;
   private static long pendingQueryExpiresAtMs;
   private static String activeQuery;

   private AhSearchAutomation() {
   }

   public static synchronized void queueSearch(String query) {
      if (query == null) {
         pendingQuery = null;
         pendingQueryExpiresAtMs = 0L;
         return;
      }
      String trimmed = query.trim();
      pendingQuery = trimmed;
      pendingQueryExpiresAtMs = System.currentTimeMillis() + 15000L;
   }

   public static synchronized void setActiveQuery(String query) {
      if (query == null || query.isBlank()) {
         activeQuery = null;
      } else {
         activeQuery = query;
      }
   }

   public static synchronized String getActiveQuery() {
      return activeQuery;
   }

   public static synchronized boolean isSearchActive() {
      return activeQuery != null && !activeQuery.isBlank();
   }

   public static synchronized String getPendingQueryIfValid() {
      if (pendingQuery == null) {
         return null;
      }
      if (System.currentTimeMillis() > pendingQueryExpiresAtMs) {
         pendingQuery = null;
         pendingQueryExpiresAtMs = 0L;
         return null;
      }
      return pendingQuery;
   }

   public static synchronized String consumePendingQuery() {
      String current = getPendingQueryIfValid();
      pendingQuery = null;
      pendingQueryExpiresAtMs = 0L;
      return current;
   }
}
