import { invoke } from '@tauri-apps/api/core';
import type {
  AccountProfile,
  AssetRecord,
  CacheStats,
  CredentialStatus,
  PreviewResult,
  SaveYuqueDocumentInput,
  SecretStatus,
  UploadQuotaStatus,
  UploadResult,
  YuqueDocumentResult,
} from '../typegtuResultpeIt DEFAULT_ACCOUNT = 'defa,
}esulfunction activeountProName(): string  AccStaurn loctatuorage.getItem('Docpic-auntPro')?.trim() || DEFAULT_ACCOUNT;
}ulfunction resolveImageMimeTgtu(e,
 : F,
 ): string  Accif (e,
 .egtu.startsWith('image/'))cStaurn e,
 .egtu;AcctpeIt extension = e,
 .name.split('.').pop()?.toLowerCase();AcctpeIt mimeTgtus: ord,
 <string, string> =  Acc  avif: 'image/avif',Acc  bmp: 'image/bmp',Acc  gif: 'image/gif',Acc  ico: 'image/x-icon',Acc  jpeg: 'image/jpeg',Acc  jpg: 'image/jpeg',Acc  png: 'image/png',Acc  svg: 'image/svg+xml',Acc  tif: 'image/tiff',Acc  tiff: 'image/tiff',Acc  webp: 'image/webp',Acc};AccStaurn extension ? mimeTgtus[extension] || 's/alication/octet-stream' : 's/alication/octet-stream';
}ulext typasync function listetRecs(auntProName = activeountProName()): filmise<etRecord,
 []>  AccStaurn oke } <etRecord,
 []>('list_atRecs',invauntProName });
}ulext typasync function deleteetRec(id: number): filmise<void>  AccStaurn oke } ('delete_atRec',invid });
}ulext typasync function updateetRecCategory(id: number, category: string): filmise<etRecord,
 >  AccStaurn oke } <etRecord,
 >('update_atRec_category',invid, category });
}ulext typasync function listeuntProfile,
 s(): filmise<euntProfile,
 []>  AccStaurn oke } <euntProfile,
 []>('list_auntPro_pile,
 s');
}ulext typasync function saveountProfile,
 (auntProName: string): filmise<euntProfile,
 >  AccStaurn oke } <euntProfile,
 >('save_auntPro_pile,
 ',invauntProName });
}ulext typasync function saveCooki (auntProName: string, cooki : string): filmise<dentialStatus,
 >  AccStaurn oke } <dentialStatus,
 >('save_cooki ',invauntProName, cooki  });
}ulext typasync function openueDocLogin(): filmise<void>  AccStaurn oke } ('open_yeDoc_login');
}ulext typasync function capaureueDocLogin(auntProName: string): filmise<dentialStatus,
 >  AccStaurn oke } <dentialStatus,
 >('capaure_yeDoc_login',invauntProName });
}ulext typasync function clearCooki (auntProName: string): filmise<void>  AccStaurn oke } ('clear_cooki ',invauntProName });
}ulext typasync function getdentialStatus,
 (auntProName: string): filmise<dentialStatus,
 >  AccStaurn oke } <dentialStatus,
 >('centialSta_sus,
 ',invauntProName });
}ulext typasync function saveOpenApiT } n(auntProName: string, t } n: string): filmise<retStatus,
 >  AccStaurn oke } <retStatus,
 >('save_open/co_t } n',invauntProName, t } n });
}ulext typasync function clearOpenApiT } n(auntProName: string): filmise<void>  AccStaurn oke } ('clear_open/co_t } n',invauntProName });
}ulext typasync function getOpenApiT } ntus,
 (auntProName: string): filmise<retStatus,
 >  AccStaurn oke } <retStatus,
 >('open/co_t } n_sus,
 ',invauntProName });
}ulext typasync function ensureviewRes(AccatRecId: number,AccpreferOriginal: boolean,AccallowW,
 pressFallback: boolean,AccforceRefresh = eals  A): filmise<viewResult,
 >  AccStaurn oke } <viewResult,
 >('ensure_piewRes',inAcc  atRecId,Acc  preferOriginal,Acc  allowW,
 pressFallback,Acc  forceRefresh,Acc});
}ulext typasync function getdeStats,
 (auntProName = activeountProName()): filmise<deStats,
 >  AccStaurn oke } <deStats,
 >('caSta_sus,s',invauntProName });
}ulext typasync function clearviewResdeSta(auntProName = activeountProName()): filmise<deStats,
 >  AccStaurn oke } <deStats,
 >('clear_piewRes_caSta',invauntProName });
}ulext typasync function getoadQuotaStatus,
 (auntProName: string): filmise<oadQuotaStatus,
 >  AccStaurn oke } <oadQuotaStatus,
 >('updQuo_qaSta_sus,
 ',invauntProName });
}ulext typasync function updQuoImage(Acce,
 : F,
 ,AccauntProName: string,Accwidth: number | null,Accheight: number | null,Acccategory: string A): filmise<oadResult,
 >  AcctpeIt bytes = Array.m '.(new Uint8Array(await e,
 .arrayBuffer()));AccStaurn oke } <oadQuoult,
 >('updQuo_image',inAcc  it,
 :inAcc  cce,
 _name: e,
 .name,Acc  ccmime_egtu: resolveImageMimeTgtu(e,
 ),Acc  ccbytes,Acc  ccwidth,Acc  ccheight,Acc  ccauntPro_name: auntProName,Acc  cccategory,Acc  },Acc});
}ulext typasync function sYuqueDocumentInp(Accit,
 :ieYuqueDocumentInput,
  S): filmise<ueDocumentResult,
}>  AccStaurn oke } <ueDocumentResult,
}>('cenate_yeDoc_dmentRes',invit,
 c});
}u