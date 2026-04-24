package dev.candycup.lifestealutils.features.resources;

import dev.candycup.lifestealutils.config.configurables.ConfigurableBoolean;
import dev.candycup.configura.serial.SerialEntry;
import lombok.Getter;

public class ResourcePackOverrides {
   @SerialEntry(comment = "Whether to enable server-provided emoji model/font mappings")
   @ConfigurableBoolean(location = "customization.resourcepack.enableemojis", icon = "minecraft:book")
   @Getter
   private static boolean enableEmojis = true;

   @SerialEntry(comment = "Whether to enable server-provided shield item overrides")
   @ConfigurableBoolean(location = "customization.resourcepack.enableshieldskins", icon = "minecraft:shield")
   @Getter
   private static boolean enableShieldSkins = true;

   @SerialEntry(comment = "Whether to enable server-provided sword item overrides")
   @ConfigurableBoolean(location = "customization.resourcepack.enableswordskins", icon = "minecraft:diamond_sword")
   @Getter
   private static boolean enableSwordSkins = true;

   @SerialEntry(comment = "Whether to enable server-provided axe item overrides")
   @ConfigurableBoolean(location = "customization.resourcepack.enableaxeskins", icon = "minecraft:diamond_axe")
   @Getter
   private static boolean enableAxeSkins = true;

   @SerialEntry(comment = "Whether to enable server-provided pickaxe item overrides")
   @ConfigurableBoolean(location = "customization.resourcepack.enablepickaxeskins", icon = "minecraft:diamond_pickaxe")
   @Getter
   private static boolean enablePickaxeSkins = true;

   @SerialEntry(comment = "Whether to enable server-provided shovel item overrides")
   @ConfigurableBoolean(location = "customization.resourcepack.enableshovelskins", icon = "minecraft:diamond_shovel")
   @Getter
   private static boolean enableShovelSkins = true;

   @SerialEntry(comment = "Whether to enable server-provided mace item overrides")
   @ConfigurableBoolean(location = "customization.resourcepack.enablemaceskins", icon = "minecraft:mace")
   @Getter
   private static boolean enableMaceSkins = true;

   @SerialEntry(comment = "Whether to enable server-provided bow item overrides")
   @ConfigurableBoolean(location = "customization.resourcepack.enablebowskins", icon = "minecraft:bow")
   @Getter
   private static boolean enableBowSkins = true;

   @SerialEntry(comment = "Whether to enable server-provided crossbow item overrides")
   @ConfigurableBoolean(location = "customization.resourcepack.enablecrossbowskins", icon = "minecraft:crossbow")
   @Getter
   private static boolean enableCrossbowSkins = true;
}
