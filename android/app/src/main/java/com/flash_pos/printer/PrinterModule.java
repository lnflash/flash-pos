package com.flash_pos.printer;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.ServiceConnection;
import android.graphics.Bitmap;
import android.os.IBinder;
import android.os.RemoteException;
import android.util.Log;
import android.widget.Toast;
import android.util.Base64;
import android.graphics.BitmapFactory;
import androidx.core.content.ContextCompat;


import androidx.annotation.NonNull;

import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;

import recieptservice.com.recieptservice.PrinterInterface;

public class PrinterModule extends ReactContextBaseJavaModule {

    // 缺纸异常
    public final static String OUT_OF_PAPER_ACTION = "printer_paper_not_ready";
    // 可以打印
    public final static String NORMAL_ACTION = "printer_paper_ready";
    // 打印头过热异常
    public final static String OVER_HEATING_ACITON = "printer_normal_heat";

    private ServiceConnection connService = new ServiceConnection() {
        @Override
        public void onServiceDisconnected(ComponentName name) {
            printerInterface = null;
        }

        @Override
        public void onServiceConnected(ComponentName name, IBinder service) {
            printerInterface = PrinterInterface.Stub.asInterface(service);
        }
    };
    private PrinterInterface printerInterface;

    private PrinterReceiver receiver = new PrinterReceiver();

    public static ReactApplicationContext reactApplicationContext;


    public PrinterModule(ReactApplicationContext context) {
        super(context);
        reactApplicationContext=context;
        Intent intent = new Intent();
        intent.setClassName("recieptservice.com.recieptservice", "recieptservice.com.recieptservice.service.PrinterService");
        context.startService(intent);
        context.bindService(intent, connService, Context.BIND_AUTO_CREATE);
        IntentFilter mFilter = new IntentFilter();
        mFilter.addAction(OUT_OF_PAPER_ACTION);
        mFilter.addAction(NORMAL_ACTION);
        mFilter.addAction(OVER_HEATING_ACITON);
        
        ContextCompat.registerReceiver(
            context,
            receiver,
            mFilter,
            ContextCompat.RECEIVER_NOT_EXPORTED // 👈 Add this flag
        );
    }


    @NonNull
    @Override
    public String getName() {
        return "PrinterModule";
    }

    @ReactMethod
    void printText(String text){
        if(printerInterface!=null){
            try {
                printerInterface.printText(text);
            } catch (RemoteException e) {
                e.printStackTrace();
            }
        }
    }

    
    @ReactMethod
    void printBarCode(String data, int symbology, int height, int width){
        if(printerInterface!=null){
            try {
                printerInterface.printBarCode(data,symbology,height,width);
            } catch (RemoteException e) {
                e.printStackTrace();
            }
        }
    }
    @ReactMethod
    void printQRCode(String data, int modulesize, int errorlevel){
        if(printerInterface!=null){
            try {
                printerInterface.printQRCode(data,modulesize,errorlevel);
            } catch (RemoteException e) {
                e.printStackTrace();
            }
        }
    }
    @ReactMethod
    void setAlignment(int alignment){
        if(printerInterface!=null){
            try {
                printerInterface.setAlignment(alignment);
            } catch (RemoteException e) {
                e.printStackTrace();
            }
        }
    }
    @ReactMethod
    void setTextSize(float textSize){
        if(printerInterface!=null){
            try {
                printerInterface.setTextSize(textSize);
            } catch (RemoteException e) {
                e.printStackTrace();
            }
        }
    }
    @ReactMethod
    void nextLine(int line){
        if(printerInterface!=null){
            try {
                printerInterface.nextLine(line);
            } catch (RemoteException e) {
                e.printStackTrace();
            }
        }
    }
    @ReactMethod
    void setTextBold(boolean bold){
        if(printerInterface!=null){
            try {
                printerInterface.setTextBold(bold);
            } catch (RemoteException e) {
                e.printStackTrace();
            }
        }
    }
    @ReactMethod
    void setDark(int value){
        if(printerInterface!=null){
            try {
                printerInterface.setDark(value);
            } catch (RemoteException e) {
                e.printStackTrace();
            }
        }
    }
    @ReactMethod
    void setLineHeight(float lineHeight){
        if(printerInterface!=null){
            try {
                printerInterface.setLineHeight(lineHeight);
            } catch (RemoteException e) {
                e.printStackTrace();
            }
        }
    }
    @ReactMethod
    void setTextDoubleWidth(boolean enable){
        if(printerInterface!=null){
            try {
                printerInterface.setTextDoubleWidth(enable);
            } catch (RemoteException e) {
                e.printStackTrace();
            }
        }
    }
    @ReactMethod
    void setTextDoubleHeight(boolean enable){
        if(printerInterface!=null){
            try {
                printerInterface.setTextDoubleHeight(enable);
            } catch (RemoteException e) {
                e.printStackTrace();
            }
        }
    }

    @ReactMethod
    void test(){
        Toast.makeText( getReactApplicationContext(),"呵呵",Toast.LENGTH_LONG).show();
    }
}
