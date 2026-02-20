package dev.candycup.lifestealutils.gaia.modules.curiositas;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.candycup.lifestealutils.gaia.GaiaApiClient;
import dev.candycup.lifestealutils.gaia.curiositas.CuriositasBaltopSnapshotClient;
import dev.candycup.lifestealutils.interapi.NetworkUtilsController;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;

public final class CuriositasModule {
   private static final Logger LOGGER = LoggerFactory.getLogger("lifestealutils/curiositas-baltop-snapshot");
   private static final Gson GSON = new GsonBuilder().create();
   private static final Duration API_TIMEOUT = Duration.ofSeconds(10);
   private static final String CURIOSITAS_BASE_PATH = "/v1/curiositas";
   private static final String BALTOP_PAST_SNAPSHOT_PATH = "/baltop-past-snapshot";

   private final GaiaApiClient apiClient;

   public CuriositasModule(GaiaApiClient apiClient) {
      this.apiClient = apiClient;
   }

   public CompletableFuture<CuriositasBaltopSnapshotClient.SnapshotResponse> fetchSnapshot(CuriositasBaltopSnapshotClient.SnapshotRange range) {
      return CompletableFuture.supplyAsync(() -> {
         NetworkUtilsController.HttpResult result = apiClient.getWithAuth(
                 CURIOSITAS_BASE_PATH + BALTOP_PAST_SNAPSHOT_PATH + "?range=" + range.queryValue(),
                 API_TIMEOUT,
                 0
         );

         if (!result.success()) {
            LOGGER.debug("failed to fetch curiositas baltop snapshot: {}", result.error());
            return null;
         }

         return parseSnapshotResponse(result.body(), range);
      });
   }

   private static CuriositasBaltopSnapshotClient.SnapshotResponse parseSnapshotResponse(String body, CuriositasBaltopSnapshotClient.SnapshotRange fallbackRange) {
      if (body == null || body.isBlank()) {
         return null;
      }

      try {
         JsonObject root = GSON.fromJson(body, JsonObject.class);
         if (root == null || !root.has("success") || !root.get("success").getAsBoolean()) {
            return null;
         }

         CuriositasBaltopSnapshotClient.SnapshotRange parsedRange = fallbackRange;
         if (root.has("range") && root.get("range").isJsonPrimitive()) {
            String value = root.get("range").getAsString();
            if (CuriositasBaltopSnapshotClient.SnapshotRange.RANGE_24_HOURS.queryValue().equals(value)) {
               parsedRange = CuriositasBaltopSnapshotClient.SnapshotRange.RANGE_24_HOURS;
            } else if (CuriositasBaltopSnapshotClient.SnapshotRange.RANGE_7_DAYS.queryValue().equals(value)) {
               parsedRange = CuriositasBaltopSnapshotClient.SnapshotRange.RANGE_7_DAYS;
            }
         }

         JsonArray entriesArray = root.has("entries") && root.get("entries").isJsonArray()
                 ? root.getAsJsonArray("entries")
                 : new JsonArray();

         List<CuriositasBaltopSnapshotClient.SnapshotEntry> entries = new ArrayList<>();
         for (JsonElement element : entriesArray) {
            if (!element.isJsonObject()) {
               continue;
            }

            JsonObject entryObject = element.getAsJsonObject();
            if (!entryObject.has("username") || !entryObject.has("currentAmount")) {
               continue;
            }

            String username = entryObject.get("username").getAsString();
            Long currentAmountLong = parseAmount(entryObject.get("currentAmount"));
            if (currentAmountLong == null) {
               continue;
            }

            Long pastAmountLong = null;
            if (entryObject.has("pastAmount") && !entryObject.get("pastAmount").isJsonNull()) {
               pastAmountLong = parseAmount(entryObject.get("pastAmount"));
            }

            entries.add(new CuriositasBaltopSnapshotClient.SnapshotEntry(username, currentAmountLong, pastAmountLong));
         }

         return new CuriositasBaltopSnapshotClient.SnapshotResponse(parsedRange, entries);
      } catch (Exception exception) {
         LOGGER.debug("failed to parse curiositas snapshot response: {}", exception.getMessage());
         return null;
      }
   }

   private static Long parseAmount(JsonElement element) {
      if (element == null || element.isJsonNull()) {
         return null;
      }

      try {
         String value = element.getAsString();
         return Long.parseLong(value);
      } catch (Exception exception) {
         return null;
      }
   }
}