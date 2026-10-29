

function   registerProvider   (   name   ,   factory   )   {
    const   key   =   String   (   name   )   .   toLowerCase   (   )   ;
    providers   .   set   (   key   ,   factory   )   ;
    return   key   ;
}

