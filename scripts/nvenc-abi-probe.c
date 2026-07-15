/* ABI ground truth for the NVENC structs we bind by hand.
   Dev-time only: output is baked into Rust const_assert!s. */
#include <windows.h>
#include <stdint.h>
#include <stdio.h>
#include "nvEncodeAPI.h"

#define SZ(t)      printf("size  %-46s %zu\n", #t, sizeof(t))
#define OF(t, f)   printf("off   %-46s %zu\n", #t "." #f, offsetof(t, f))
#define VAL(n, v)  printf("const %-46s 0x%08X\n", n, (unsigned)(v))

int main(void) {
    printf("--- api version\n");
    VAL("NVENCAPI_VERSION", NVENCAPI_VERSION);
    VAL("NV_ENC_CONFIG_VER", NV_ENC_CONFIG_VER);
    VAL("NV_ENC_INITIALIZE_PARAMS_VER", NV_ENC_INITIALIZE_PARAMS_VER);
    VAL("NV_ENC_RECONFIGURE_PARAMS_VER", NV_ENC_RECONFIGURE_PARAMS_VER);
    VAL("NV_ENC_PRESET_CONFIG_VER", NV_ENC_PRESET_CONFIG_VER);
    VAL("NV_ENC_PIC_PARAMS_VER", NV_ENC_PIC_PARAMS_VER);
    VAL("NV_ENC_LOCK_BITSTREAM_VER", NV_ENC_LOCK_BITSTREAM_VER);
    VAL("NV_ENC_REGISTER_RESOURCE_VER", NV_ENC_REGISTER_RESOURCE_VER);
    VAL("NV_ENC_MAP_INPUT_RESOURCE_VER", NV_ENC_MAP_INPUT_RESOURCE_VER);
    VAL("NV_ENC_CREATE_BITSTREAM_BUFFER_VER", NV_ENC_CREATE_BITSTREAM_BUFFER_VER);
    VAL("NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER", NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER);
    VAL("NV_ENC_CAPS_PARAM_VER", NV_ENC_CAPS_PARAM_VER);
    VAL("NV_ENC_RC_PARAMS_VER", NV_ENC_RC_PARAMS_VER);
    VAL("NV_ENCODE_API_FUNCTION_LIST_VER", NV_ENCODE_API_FUNCTION_LIST_VER);
    VAL("NVENC_INFINITE_GOPLENGTH", NVENC_INFINITE_GOPLENGTH);

    printf("--- sizes\n");
    SZ(GUID);
    SZ(NV_ENC_CAPS_PARAM);
    SZ(NV_ENC_QP);
    SZ(NV_ENC_RC_PARAMS);
    SZ(NV_ENC_CONFIG_H264_VUI_PARAMETERS);
    SZ(NV_ENC_CONFIG_H264);
    SZ(NV_ENC_CONFIG_HEVC);
    SZ(NV_ENC_CONFIG_AV1);
    SZ(NV_ENC_CONFIG_H264_MEONLY);
    SZ(NV_ENC_CONFIG_HEVC_MEONLY);
    SZ(NV_ENC_CODEC_CONFIG);
    SZ(NV_ENC_CONFIG);
    SZ(NV_ENC_INITIALIZE_PARAMS);
    SZ(NV_ENC_RECONFIGURE_PARAMS);
    SZ(NV_ENC_PRESET_CONFIG);
    SZ(NV_ENC_PIC_PARAMS_H264);
    SZ(NV_ENC_CODEC_PIC_PARAMS);
    SZ(NV_ENC_PIC_PARAMS);
    SZ(NV_ENC_LOCK_BITSTREAM);
    SZ(NV_ENC_REGISTER_RESOURCE);
    SZ(NV_ENC_MAP_INPUT_RESOURCE);
    SZ(NV_ENC_CREATE_BITSTREAM_BUFFER);
    SZ(NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS);
    SZ(NVENC_EXTERNAL_ME_HINT_COUNTS_PER_BLOCKTYPE);
    SZ(NV_ENCODE_API_FUNCTION_LIST);

    printf("--- NV_ENC_RC_PARAMS\n");
    OF(NV_ENC_RC_PARAMS, rateControlMode);
    OF(NV_ENC_RC_PARAMS, constQP);
    OF(NV_ENC_RC_PARAMS, averageBitRate);
    OF(NV_ENC_RC_PARAMS, maxBitRate);
    OF(NV_ENC_RC_PARAMS, vbvBufferSize);
    OF(NV_ENC_RC_PARAMS, vbvInitialDelay);
    OF(NV_ENC_RC_PARAMS, minQP);
    OF(NV_ENC_RC_PARAMS, maxQP);
    OF(NV_ENC_RC_PARAMS, initialRCQP);
    OF(NV_ENC_RC_PARAMS, targetQuality);
    OF(NV_ENC_RC_PARAMS, lookaheadDepth);
    OF(NV_ENC_RC_PARAMS, qpMapMode);
    OF(NV_ENC_RC_PARAMS, multiPass);

    printf("--- NV_ENC_CONFIG_H264\n");
    OF(NV_ENC_CONFIG_H264, level);
    OF(NV_ENC_CONFIG_H264, idrPeriod);
    OF(NV_ENC_CONFIG_H264, entropyCodingMode);
    OF(NV_ENC_CONFIG_H264, intraRefreshPeriod);
    OF(NV_ENC_CONFIG_H264, maxNumRefFrames);
    OF(NV_ENC_CONFIG_H264, sliceMode);
    OF(NV_ENC_CONFIG_H264, sliceModeData);
    OF(NV_ENC_CONFIG_H264, h264VUIParameters);
    OF(NV_ENC_CONFIG_H264, chromaFormatIDC);
    OF(NV_ENC_CONFIG_H264, numRefL0);

    printf("--- NV_ENC_CONFIG_H264_VUI_PARAMETERS\n");
    OF(NV_ENC_CONFIG_H264_VUI_PARAMETERS, videoSignalTypePresentFlag);
    OF(NV_ENC_CONFIG_H264_VUI_PARAMETERS, videoFullRangeFlag);
    OF(NV_ENC_CONFIG_H264_VUI_PARAMETERS, bitstreamRestrictionFlag);
    OF(NV_ENC_CONFIG_H264_VUI_PARAMETERS, timingInfoPresentFlag);

    printf("--- NV_ENC_CONFIG\n");
    OF(NV_ENC_CONFIG, profileGUID);
    OF(NV_ENC_CONFIG, gopLength);
    OF(NV_ENC_CONFIG, frameIntervalP);
    OF(NV_ENC_CONFIG, monoChromeEncoding);
    OF(NV_ENC_CONFIG, frameFieldMode);
    OF(NV_ENC_CONFIG, mvPrecision);
    OF(NV_ENC_CONFIG, rcParams);
    OF(NV_ENC_CONFIG, encodeCodecConfig);

    printf("--- NV_ENC_INITIALIZE_PARAMS\n");
    OF(NV_ENC_INITIALIZE_PARAMS, encodeGUID);
    OF(NV_ENC_INITIALIZE_PARAMS, presetGUID);
    OF(NV_ENC_INITIALIZE_PARAMS, encodeWidth);
    OF(NV_ENC_INITIALIZE_PARAMS, encodeHeight);
    OF(NV_ENC_INITIALIZE_PARAMS, darWidth);
    OF(NV_ENC_INITIALIZE_PARAMS, frameRateNum);
    OF(NV_ENC_INITIALIZE_PARAMS, frameRateDen);
    OF(NV_ENC_INITIALIZE_PARAMS, enableEncodeAsync);
    OF(NV_ENC_INITIALIZE_PARAMS, enablePTD);
    OF(NV_ENC_INITIALIZE_PARAMS, privDataSize);
    OF(NV_ENC_INITIALIZE_PARAMS, privData);
    OF(NV_ENC_INITIALIZE_PARAMS, encodeConfig);
    OF(NV_ENC_INITIALIZE_PARAMS, maxEncodeWidth);
    OF(NV_ENC_INITIALIZE_PARAMS, maxEncodeHeight);
    OF(NV_ENC_INITIALIZE_PARAMS, maxMEHintCountsPerBlock);
    OF(NV_ENC_INITIALIZE_PARAMS, tuningInfo);
    OF(NV_ENC_INITIALIZE_PARAMS, bufferFormat);

    printf("--- NV_ENC_RECONFIGURE_PARAMS\n");
    OF(NV_ENC_RECONFIGURE_PARAMS, reInitEncodeParams);

    printf("--- NV_ENC_PRESET_CONFIG\n");
    OF(NV_ENC_PRESET_CONFIG, presetCfg);

    printf("--- NV_ENC_PIC_PARAMS\n");
    OF(NV_ENC_PIC_PARAMS, inputWidth);
    OF(NV_ENC_PIC_PARAMS, inputHeight);
    OF(NV_ENC_PIC_PARAMS, inputPitch);
    OF(NV_ENC_PIC_PARAMS, encodePicFlags);
    OF(NV_ENC_PIC_PARAMS, frameIdx);
    OF(NV_ENC_PIC_PARAMS, inputTimeStamp);
    OF(NV_ENC_PIC_PARAMS, inputDuration);
    OF(NV_ENC_PIC_PARAMS, inputBuffer);
    OF(NV_ENC_PIC_PARAMS, outputBitstream);
    OF(NV_ENC_PIC_PARAMS, completionEvent);
    OF(NV_ENC_PIC_PARAMS, bufferFmt);
    OF(NV_ENC_PIC_PARAMS, pictureStruct);
    OF(NV_ENC_PIC_PARAMS, pictureType);
    OF(NV_ENC_PIC_PARAMS, codecPicParams);

    printf("--- NV_ENC_PIC_PARAMS_H264\n");
    OF(NV_ENC_PIC_PARAMS_H264, displayPOCSyntax);
    OF(NV_ENC_PIC_PARAMS_H264, refPicFlag);
    OF(NV_ENC_PIC_PARAMS_H264, forceIntraRefreshWithFrameCnt);
    OF(NV_ENC_PIC_PARAMS_H264, sliceTypeData);
    OF(NV_ENC_PIC_PARAMS_H264, seiPayloadArray);
    OF(NV_ENC_PIC_PARAMS_H264, sliceMode);

    printf("--- NV_ENC_LOCK_BITSTREAM\n");
    OF(NV_ENC_LOCK_BITSTREAM, outputBitstream);
    OF(NV_ENC_LOCK_BITSTREAM, sliceOffsets);
    OF(NV_ENC_LOCK_BITSTREAM, frameIdx);
    OF(NV_ENC_LOCK_BITSTREAM, hwEncodeStatus);
    OF(NV_ENC_LOCK_BITSTREAM, numSlices);
    OF(NV_ENC_LOCK_BITSTREAM, bitstreamSizeInBytes);
    OF(NV_ENC_LOCK_BITSTREAM, outputTimeStamp);
    OF(NV_ENC_LOCK_BITSTREAM, outputDuration);
    OF(NV_ENC_LOCK_BITSTREAM, bitstreamBufferPtr);
    OF(NV_ENC_LOCK_BITSTREAM, pictureType);
    OF(NV_ENC_LOCK_BITSTREAM, frameAvgQP);

    printf("--- NV_ENC_REGISTER_RESOURCE\n");
    OF(NV_ENC_REGISTER_RESOURCE, resourceType);
    OF(NV_ENC_REGISTER_RESOURCE, width);
    OF(NV_ENC_REGISTER_RESOURCE, height);
    OF(NV_ENC_REGISTER_RESOURCE, pitch);
    OF(NV_ENC_REGISTER_RESOURCE, subResourceIndex);
    OF(NV_ENC_REGISTER_RESOURCE, resourceToRegister);
    OF(NV_ENC_REGISTER_RESOURCE, registeredResource);
    OF(NV_ENC_REGISTER_RESOURCE, bufferFormat);
    OF(NV_ENC_REGISTER_RESOURCE, bufferUsage);
    OF(NV_ENC_REGISTER_RESOURCE, pInputFencePoint);

    printf("--- NV_ENC_MAP_INPUT_RESOURCE\n");
    OF(NV_ENC_MAP_INPUT_RESOURCE, subResourceIndex);
    OF(NV_ENC_MAP_INPUT_RESOURCE, inputResource);
    OF(NV_ENC_MAP_INPUT_RESOURCE, registeredResource);
    OF(NV_ENC_MAP_INPUT_RESOURCE, mappedResource);
    OF(NV_ENC_MAP_INPUT_RESOURCE, mappedBufferFmt);

    printf("--- NV_ENC_CREATE_BITSTREAM_BUFFER\n");
    OF(NV_ENC_CREATE_BITSTREAM_BUFFER, size);
    OF(NV_ENC_CREATE_BITSTREAM_BUFFER, memoryHeap);
    OF(NV_ENC_CREATE_BITSTREAM_BUFFER, bitstreamBuffer);
    OF(NV_ENC_CREATE_BITSTREAM_BUFFER, bitstreamBufferPtr);

    printf("--- NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS\n");
    OF(NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS, deviceType);
    OF(NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS, device);
    OF(NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS, apiVersion);

    printf("--- NV_ENCODE_API_FUNCTION_LIST\n");
    OF(NV_ENCODE_API_FUNCTION_LIST, nvEncOpenEncodeSession);
    OF(NV_ENCODE_API_FUNCTION_LIST, nvEncGetEncodeGUIDs);
    OF(NV_ENCODE_API_FUNCTION_LIST, nvEncGetEncodeCaps);
    OF(NV_ENCODE_API_FUNCTION_LIST, nvEncGetEncodePresetConfigEx);
    OF(NV_ENCODE_API_FUNCTION_LIST, nvEncInitializeEncoder);
    OF(NV_ENCODE_API_FUNCTION_LIST, nvEncCreateBitstreamBuffer);
    OF(NV_ENCODE_API_FUNCTION_LIST, nvEncDestroyBitstreamBuffer);
    OF(NV_ENCODE_API_FUNCTION_LIST, nvEncEncodePicture);
    OF(NV_ENCODE_API_FUNCTION_LIST, nvEncLockBitstream);
    OF(NV_ENCODE_API_FUNCTION_LIST, nvEncUnlockBitstream);
    OF(NV_ENCODE_API_FUNCTION_LIST, nvEncDestroyEncoder);
    OF(NV_ENCODE_API_FUNCTION_LIST, nvEncRegisterResource);
    OF(NV_ENCODE_API_FUNCTION_LIST, nvEncUnregisterResource);
    OF(NV_ENCODE_API_FUNCTION_LIST, nvEncMapInputResource);
    OF(NV_ENCODE_API_FUNCTION_LIST, nvEncUnmapInputResource);
    OF(NV_ENCODE_API_FUNCTION_LIST, nvEncOpenEncodeSessionEx);
    OF(NV_ENCODE_API_FUNCTION_LIST, nvEncReconfigureEncoder);
    OF(NV_ENCODE_API_FUNCTION_LIST, nvEncGetLastErrorString);
    return 0;
}
