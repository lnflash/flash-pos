package com.flash_pos.printer;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import com.facebook.react.modules.core.DeviceEventManagerModule;

public class PrinterReceiver extends BroadcastReceiver {
    public PrinterReceiver() {
    }

    @Override
    public void onReceive(Context context, Intent data) {
        String action = data.getAction();
        String type = "PrinterStatus";
        Log.d("PrinterReceiver", action);

        if (PrinterModule.reactApplicationContext != null) {
            PrinterModule.reactApplicationContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                    .emit(type, action);
        }
    }
}
