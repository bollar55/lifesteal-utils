package dev.candycup.lifestealutils.gaia.modules.alliances;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.candycup.lifestealutils.features.alliances.AllianceModels;
import dev.candycup.lifestealutils.gaia.GaiaApiClient;
import dev.candycup.lifestealutils.interapi.NetworkUtilsController;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

public final class AlliancesModule {
   private static final Gson GSON = new GsonBuilder().create();
   private static final Duration API_TIMEOUT = Duration.ofSeconds(10);
   private static final String BASE_PATH = "/v1/alliances";

   private final GaiaApiClient apiClient;

   public AlliancesModule(GaiaApiClient apiClient) {
      this.apiClient = apiClient;
   }

   public List<AllianceModels.AllianceRecord> listSubscriptions() {
      NetworkUtilsController.HttpResult result = apiClient.getWithAuth(BASE_PATH + "/subscriptions", API_TIMEOUT, 0);
      if (!result.success() || result.body() == null || result.body().isBlank()) {
         return List.of();
      }

      try {
         JsonObject root = GSON.fromJson(result.body(), JsonObject.class);
         if (root == null || !root.has("alliances") || !root.get("alliances").isJsonArray()) {
            return List.of();
         }
         JsonArray alliances = root.getAsJsonArray("alliances");
         ArrayList<AllianceModels.AllianceRecord> out = new ArrayList<>();
         for (JsonElement element : alliances) {
            if (!element.isJsonObject()) {
               continue;
            }
            AllianceModels.AllianceRecord parsed = parseServerAlliance(element.getAsJsonObject());
            if (parsed != null) {
               out.add(parsed);
            }
         }
         return out;
      } catch (Exception ignored) {
         return List.of();
      }
   }

   public AllianceModels.AllianceRecord createAlliance(AllianceModels.AllianceRecord local) {
      JsonObject payload = new JsonObject();
      payload.addProperty("subscriptionPermission", normalizePermission(local.subscriptionPermission));
      payload.add("data", GSON.toJsonTree(local.data));

      NetworkUtilsController.HttpResult result = apiClient.postJsonWithAuth(BASE_PATH, payload.toString(), API_TIMEOUT, 0);
      if (!result.success() || result.body() == null || result.body().isBlank()) {
         return null;
      }

      try {
         JsonObject root = GSON.fromJson(result.body(), JsonObject.class);
         if (root == null) {
            return null;
         }
         JsonObject allianceObject = root.has("alliance") && root.get("alliance").isJsonObject()
                 ? root.getAsJsonObject("alliance")
                 : root;
         return parseServerAlliance(allianceObject);
      } catch (Exception ignored) {
         return null;
      }
   }

   public boolean replaceAllianceData(AllianceModels.AllianceRecord local) {
      if (local == null || local.serverId == null || local.serverId.isBlank()) {
         return false;
      }
      JsonObject payload = new JsonObject();
      payload.add("data", GSON.toJsonTree(local.data));
      payload.addProperty("subscriptionPermission", normalizePermission(local.subscriptionPermission));
      NetworkUtilsController.HttpResult result = apiClient.putJsonWithAuth(BASE_PATH + "/" + local.serverId + "/data", payload.toString(), API_TIMEOUT, 0);
      return result.success();
   }

   public AllianceModels.AllianceRecord fetchById(String serverId) {
      if (serverId == null || serverId.isBlank()) {
         return null;
      }
      NetworkUtilsController.HttpResult result = apiClient.getWithAuth(BASE_PATH + "/" + serverId, API_TIMEOUT, 0);
      if (!result.success() || result.body() == null || result.body().isBlank()) {
         return null;
      }
      try {
         JsonObject root = GSON.fromJson(result.body(), JsonObject.class);
         if (root == null) {
            return null;
         }
         JsonObject allianceObject = root.has("alliance") && root.get("alliance").isJsonObject()
                 ? root.getAsJsonObject("alliance")
                 : root;
         return parseServerAlliance(allianceObject);
      } catch (Exception ignored) {
         return null;
      }
   }

   public boolean subscribe(String serverId) {
      return subscribeWithDetails(serverId).success();
   }

   public SubscriptionResult subscribeWithDetails(String serverId) {
      if (serverId == null || serverId.isBlank()) {
         return new SubscriptionResult(false, "Enter an invite code first.");
      }
      NetworkUtilsController.HttpResult result = apiClient.postJsonWithAuth(BASE_PATH + "/" + serverId + "/subscribe", "{}", API_TIMEOUT, 0);
      if (result.success()) {
         return new SubscriptionResult(true, null);
      }
      return new SubscriptionResult(false, resolveSubscribeErrorMessage(result));
   }

   public boolean unsubscribe(String serverId) {
      if (serverId == null || serverId.isBlank()) {
         return false;
      }
      NetworkUtilsController.HttpResult result = apiClient.deleteWithAuth(BASE_PATH + "/" + serverId + "/subscribe", API_TIMEOUT, 0);
      return result.success();
   }

   private AllianceModels.AllianceRecord parseServerAlliance(JsonObject object) {
      if (object == null) {
         return null;
      }
      AllianceModels.AllianceRecord record = new AllianceModels.AllianceRecord();
      record.serverId = getString(object, "id");
      record.ownerUuid = getString(object, "owner");
      record.subscriptionPermission = normalizePermission(getString(object, "subscription_permission"));
      record.createdAt = parseMillis(getString(object, "created_at"));
      record.updatedAt = parseMillis(getString(object, "updated_at"));
      record.lastSyncedAt = System.currentTimeMillis();
      record.published = true;
      record.source = "remote";
      record.syncState = "SYNCED";
      if (object.has("data")) {
         record.data = GSON.fromJson(object.get("data"), AllianceModels.AllianceData.class);
      }
      if (record.data == null) {
         record.data = new AllianceModels.AllianceData();
      }
      if (record.data.lists == null) {
         record.data.lists = new ArrayList<>();
      }
      return record;
   }

   private static String getString(JsonObject object, String key) {
      if (!object.has(key) || object.get(key).isJsonNull()) {
         return "";
      }
      try {
         return object.get(key).getAsString();
      } catch (Exception ignored) {
         return "";
      }
   }

   private static long parseMillis(String value) {
      if (value == null || value.isBlank()) {
         return 0L;
      }
      try {
         return java.time.Instant.parse(value).toEpochMilli();
      } catch (Exception ignored) {
         return 0L;
      }
   }

   private static String normalizePermission(String value) {
      if (value == null || value.isBlank()) {
         return "MEMBERS";
      }
      if (value.equalsIgnoreCase("ANYONE")) {
         return "ANYONE";
      }
      return "MEMBERS";
   }

   private static String resolveSubscribeErrorMessage(NetworkUtilsController.HttpResult result) {
      String apiMessage = extractApiErrorMessage(result);
      if (apiMessage != null && !apiMessage.isBlank()) {
         return apiMessage;
      }
      return "Subscribe failed. Please try again.";
   }

   private static String extractApiErrorMessage(NetworkUtilsController.HttpResult result) {
      String source = result.body();
      if (source == null || source.isBlank()) {
         source = result.error();
      }
      if (source == null || source.isBlank()) {
         return null;
      }
      try {
         JsonElement element = JsonParser.parseString(source);
         if (!element.isJsonObject()) {
            return source;
         }
         JsonObject object = element.getAsJsonObject();
         if (object.has("error") && !object.get("error").isJsonNull()) {
            JsonElement error = object.get("error");
            if (error.isJsonPrimitive()) {
               return error.getAsString();
            }
            if (error.isJsonObject()) {
               JsonObject errorObject = error.getAsJsonObject();
               if (errorObject.has("message") && !errorObject.get("message").isJsonNull()) {
                  return errorObject.get("message").getAsString();
               }
            }
         }
      } catch (Exception ignored) {
         return null;
      }
      return null;
   }

   public record SubscriptionResult(boolean success, String errorMessage) {
   }
}
