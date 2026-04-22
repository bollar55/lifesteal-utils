package dev.candycup.configura.ui;

import net.minecraft.network.chat.Component;
import net.minecraft.world.item.ItemStack;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import java.util.function.Function;
import java.util.function.Supplier;

public final class ConfiguraConfigModel {
   private ConfiguraConfigModel() {
   }

   public enum OptionType {
      BOOLEAN,
      STRING,
      MINIMESSAGE,
      FLOAT,
      ENUM,
      LIST
   }

   public record ResolvedConfig(Component title, List<UiCategory> categories, Runnable onSave, Runnable onSavedFeedback) {
   }

   public record UiCategory(String id, Component displayName, List<UiFeature> features) {
   }

   public record UiFeature(String id, Component displayName, List<UiConfigurable> configurables) {
   }

   public record UiConfigurable(
           String key,
           String id,
           OptionType type,
           float min,
           float max,
           boolean hasFloatBounds,
           Supplier<?> valueSupplier,
           Consumer<Object> valueConsumer,
           Supplier<?> defaultSupplier,
           Component displayName,
           Component description,
           boolean remotelyForced,
           List<? extends Enum<?>> enumValues,
           Function<Enum<?>, Component> enumLabeler,
           Supplier<ItemStack> iconSupplier
   ) {
      public Object readValue() {
         Object value = valueSupplier.get();
         if (value instanceof List<?> list) {
            return new ArrayList<>(list);
         }
         return value;
      }

      public void writeValue(Object value) {
         valueConsumer.accept(value);
      }

      public Component enumLabel(Enum<?> enumValue) {
         return enumLabeler.apply(enumValue);
      }

      public ItemStack icon() {
         if (iconSupplier == null) {
            return ItemStack.EMPTY;
         }
         ItemStack stack = iconSupplier.get();
         return stack == null ? ItemStack.EMPTY : stack;
      }
   }
}
