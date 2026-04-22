package dev.candycup.lifestealutils.features.resources;

import dev.candycup.lifestealutils.config.configurables.ConfigurableBoolean;
import dev.candycup.configura.serial.SerialEntry;
import lombok.Getter;

public class ResourcePackOverrides {
   @SerialEntry(comment = "Whether to remove server-provided emoji model/font mappings")
   @ConfigurableBoolean(location = "customization.resourcepack.removeemojis", icon = "minecraft:book")
   @Getter
   private static boolean removeEmojis = false;

   @SerialEntry(comment = "Whether to remove all server-provided shield item overrides")
   @ConfigurableBoolean(location = "customization.resourcepack.removeallshieldoverrides", icon = "minecraft:shield")
   @Getter
   private static boolean removeAllShieldOverrides = false;

   @SerialEntry(comment = "Whether to remove all server-provided sword item overrides")
   @ConfigurableBoolean(location = "customization.resourcepack.removeswordskins", icon = "minecraft:diamond_sword")
   @Getter
   private static boolean removeSwordSkins = false;

   @SerialEntry(comment = "Whether to remove all server-provided axe item overrides")
   @ConfigurableBoolean(location = "customization.resourcepack.removeaxeskins", icon = "minecraft:diamond_axe")
   @Getter
   private static boolean removeAxeSkins = false;

   @SerialEntry(comment = "Whether to remove all server-provided pickaxe item overrides")
   @ConfigurableBoolean(location = "customization.resourcepack.removepickaxeskins", icon = "minecraft:diamond_pickaxe")
   @Getter
   private static boolean removePickaxeSkins = false;

   @SerialEntry(comment = "Whether to remove all server-provided shovel item overrides")
   @ConfigurableBoolean(location = "customization.resourcepack.removeshovelskins", icon = "minecraft:diamond_shovel")
   @Getter
   private static boolean removeShovelSkins = false;

   @SerialEntry(comment = "Whether to remove all server-provided mace item overrides")
   @ConfigurableBoolean(location = "customization.resourcepack.removemaceskins", icon = "minecraft:mace")
   @Getter
   private static boolean removeMaceSkins = false;

   @SerialEntry(comment = "Whether to remove all server-provided bow item overrides")
   @ConfigurableBoolean(location = "customization.resourcepack.removebowskins", icon = "minecraft:bow")
   @Getter
   private static boolean removeBowSkins = false;

   @SerialEntry(comment = "Whether to remove all server-provided crossbow item overrides")
   @ConfigurableBoolean(location = "customization.resourcepack.removecrossbowskins", icon = "minecraft:crossbow")
   @Getter
   private static boolean removeCrossbowSkins = false;
}
