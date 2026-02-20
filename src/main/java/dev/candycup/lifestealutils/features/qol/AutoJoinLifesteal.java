package dev.candycup.lifestealutils.features.qol;

import dev.candycup.lifestealutils.Config;
import dev.candycup.lifestealutils.api.LifestealAPI;
import dev.candycup.lifestealutils.api.TablistDataController;
import dev.candycup.lifestealutils.event.LifestealUtilsEvents;
import dev.candycup.lifestealutils.event.LifestealUtilsEvents.ClientTickEvent;
import dev.candycup.lifestealutils.event.LifestealUtilsEvents.LifestealShardSwapEvent;
import dev.candycup.lifestealutils.interapi.MessagingUtils;
import net.minecraft.client.Minecraft;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * automatically joins the Lifesteal gamemode when connecting to a hub shard.
 * triggered by detecting shard names starting with 'hub-' via the lifesteal API.
 */
public class AutoJoinLifesteal {
   private static final Logger LOGGER = LoggerFactory.getLogger("lifestealutils/autojoin");
   private static final int HUB_CHECK_INTERVAL = 100; // check every 5 seconds
   private static final int JOIN_COOLDOWN = 100; // 5 second cooldown after executing command

   private int pendingJoinTicks = -1;
   private int hubCheckTicks = 0;
   private int joinCooldownTicks = 0;

   public AutoJoinLifesteal() {
      LifestealUtilsEvents.SHARD_SWAP.register(event -> {
         if (!isEnabled()) {
            return;
         }
         onShardSwap(event);
      });
      LifestealUtilsEvents.CLIENT_TICK.register(event -> {
         if (!isEnabled()) {
            return;
         }
         onClientTick(event);
      });
   }

   public boolean isEnabled() {
      return Config.isAutoJoinLifestealOnHub();
   }

   public void onShardSwap(LifestealShardSwapEvent event) {
      String shardName = event.getShardName();
      if (shardName == null || shardName.isBlank()) {
         return;
      }

      // check if we're in a hub shard (starts with 'hub-')
      if (shardName.startsWith("hub-")) {
         pendingJoinTicks = 20;
         LOGGER.debug("[lsu-autojoin] detected hub shard '{}', scheduling /joinlifesteal in 1 second", shardName);
      }
   }

   public void onClientTick(ClientTickEvent event) {
      // decrement cooldown
      if (joinCooldownTicks > 0) {
         joinCooldownTicks--;
      }

      if (pendingJoinTicks < 0) {
         // no pending join, perform periodic hub check
         hubCheckTicks++;
         if (hubCheckTicks >= HUB_CHECK_INTERVAL) {
            hubCheckTicks = 0;
            performHubCheck();
         }
         return;
      }

      if (pendingJoinTicks == 0) {
         executeJoinCommand();
         pendingJoinTicks = -1;
      } else {
         pendingJoinTicks--;
      }
   }

   private void performHubCheck() {
      // skip if still on cooldown
      if (joinCooldownTicks > 0) {
         return;
      }

      String currentShard = LifestealAPI.getCurrentShard();
      if (currentShard != null && currentShard.startsWith("hub-")) {
         LOGGER.debug("[lsu-autojoin] failsafe: still in hub shard '{}', executing /joinlifesteal", currentShard);
         executeJoinCommand();
      }
   }

   private void executeJoinCommand() {
      Minecraft client = Minecraft.getInstance();
      if (client.player != null) {
         client.player.connection.sendCommand("joinlifesteal");
         MessagingUtils.showMiniMessage("<gray><italic>[Lifesteal Utils Join Macro] Forwarding you to the lifesteal gamemode... this can be disabled in /lsu config!</italic></gray>");
         LOGGER.info("[lsu-autojoin] executed /joinlifesteal command");
         joinCooldownTicks = JOIN_COOLDOWN;
      }
   }
}
